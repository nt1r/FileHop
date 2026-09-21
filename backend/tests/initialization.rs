mod support;
use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use portable_pty::CommandBuilder;
use std::{
    fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::PathBuf,
    process::Command,
};
use tempfile::TempDir;
use tower::ServiceExt;

struct Instance {
    _root: TempDir,
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
    fn args(&self) -> Vec<String> {
        vec![
            "--database-dir".into(),
            self.database.display().to_string(),
            "--files-dir".into(),
            self.files.display().to_string(),
        ]
    }
    fn init(&self, user: &str, password: &str, limited: bool) -> (bool, String) {
        let mut cmd = if limited {
            let mut cmd = CommandBuilder::new("bash");
            cmd.args([
                "-c",
                "ulimit -f 1; trap '' XFSZ; exec \"$@\"",
                "filehop-test",
                env!("CARGO_BIN_EXE_backend"),
            ]);
            cmd
        } else {
            CommandBuilder::new(env!("CARGO_BIN_EXE_backend"))
        };
        cmd.args(self.args());
        cmd.args(["init", "--username", user, "--confirm-paths"]);
        support::terminal(cmd, password)
    }
    fn initialize(&self) {
        let (ok, output) = self.init("Admin", " synthetic password ", false);
        assert!(ok, "{output}");
        assert!(!output.contains("synthetic password"));
    }
    async fn status(&self) -> String {
        let response = backend::app(self.database.clone(), self.files.clone())
            .oneshot(
                Request::builder()
                    .uri("/api/status")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["cache-control"], "no-store");
        let value: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 1024).await.unwrap()).unwrap();
        value["state"].as_str().unwrap().to_owned()
    }
    fn empty(&self) {
        for path in [&self.database, &self.files] {
            assert_eq!(fs::read_dir(path).unwrap().count(), 0);
        }
    }
}

#[tokio::test]
async fn fresh_start_never_creates_storage() {
    let i = Instance::new();
    assert_eq!(i.status().await, "uninitialized");
    i.empty();
}

#[tokio::test]
async fn terminal_initialization_and_repeated_status_preserve_instance() {
    let i = Instance::new();
    i.initialize();
    assert_eq!(i.status().await, "initialized");
    assert_eq!(i.status().await, "initialized");
}

#[tokio::test]
async fn existing_router_observes_initialization() {
    let i = Instance::new();
    let app = backend::app(i.database.clone(), i.files.clone());
    i.initialize();
    let response = app
        .oneshot(
            Request::builder()
                .uri("/api/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"state":"initialized"})
    );
}

#[test]
fn confirmation_required_and_password_argument_rejected() {
    let i = Instance::new();
    for args in [
        vec!["init", "--username", "admin"],
        vec![
            "init",
            "--username",
            "admin",
            "--confirm-paths",
            "--password",
            "synthetic",
        ],
    ] {
        assert!(
            !Command::new(env!("CARGO_BIN_EXE_backend"))
                .args(i.args())
                .args(args)
                .output()
                .unwrap()
                .status
                .success()
        );
    }
    i.empty();
}

#[tokio::test]
async fn business_writes_unavailable() {
    let i = Instance::new();
    for initialized in [false, true] {
        if initialized {
            i.initialize();
        }
        for path in ["/api/messages", "/api/status"] {
            let response = backend::app(i.database.clone(), i.files.clone())
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri(path)
                        .body(Body::from("{}"))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert!(matches!(
                response.status(),
                StatusCode::NOT_FOUND | StatusCode::METHOD_NOT_ALLOWED
            ));
        }
    }
}

#[tokio::test]
async fn repeat_initialization_preserves_bytes() {
    let i = Instance::new();
    i.initialize();
    let before: Vec<_> = [&i.database, &i.files]
        .into_iter()
        .flat_map(|p| fs::read_dir(p).unwrap())
        .map(|e| {
            let p = e.unwrap().path();
            let bytes = fs::read(&p).unwrap();
            (p, bytes)
        })
        .collect();
    assert!(!i.init("Other", "another password", false).0);
    for (p, bytes) in before {
        assert_eq!(fs::read(p).unwrap(), bytes);
    }
    assert_eq!(i.status().await, "initialized");
}

#[tokio::test]
async fn residue_preserved_and_refused() {
    let i = Instance::new();
    let p = i.files.join("unrelated.txt");
    fs::write(&p, "preserve").unwrap();
    assert!(!i.init("Admin", "long enough password", false).0);
    assert_eq!(fs::read_to_string(p).unwrap(), "preserve");
    assert_eq!(fs::read_dir(&i.database).unwrap().count(), 0);
    assert_eq!(i.status().await, "storage_error");
}

#[tokio::test]
async fn missing_database_never_recreated() {
    let i = Instance::new();
    i.initialize();
    let p = i.database.join("transfer.db");
    fs::rename(&p, i.database.join("original.db")).unwrap();
    assert_eq!(i.status().await, "storage_error");
    assert!(!i.init("Admin", "long enough password", false).0);
    assert!(!p.exists());
}

#[tokio::test]
async fn mismatched_and_missing_identity_fail_closed() {
    let i = Instance::new();
    i.initialize();
    let p = i.files.join("storage-id");
    fs::write(&p, "f966a9c0-cf17-4e71-a035-3a459dbb541d").unwrap();
    assert_eq!(i.status().await, "storage_error");
    fs::remove_file(&p).unwrap();
    assert_eq!(i.status().await, "storage_error");
    assert!(!i.init("Admin", "long enough password", false).0);
    assert!(!p.exists());
}

#[test]
fn invalid_credentials_leave_empty_directories() {
    let i = Instance::new();
    for (user, password) in [
        ("ab", "long enough password".into()),
        (" space", "long enough password".into()),
        ("管理员", "long enough password".into()),
        ("admin", "短".repeat(11)),
        ("admin", "a".repeat(129)),
    ] {
        assert!(!i.init(user, &password, false).0);
        i.empty();
    }
}

#[tokio::test]
async fn unicode_password_counted_as_codepoints() {
    let i = Instance::new();
    assert!(i.init("Admin", &"密".repeat(12), false).0);
    assert_eq!(i.status().await, "initialized");
}

#[tokio::test]
async fn inaccessible_storage_fails_closed() {
    let i = Instance::new();
    i.initialize();
    for (path, restore) in [
        (i.files.clone(), 0o700),
        (i.database.join("transfer.db"), 0o600),
    ] {
        fs::set_permissions(&path, fs::Permissions::from_mode(0o400)).unwrap();
        let state = i.status().await;
        fs::set_permissions(&path, fs::Permissions::from_mode(restore)).unwrap();
        assert_eq!(state, "storage_error");
    }
}

#[tokio::test]
async fn symlinked_database_refused() {
    let i = Instance::new();
    i.initialize();
    let p = i.database.join("transfer.db");
    let original = i.database.join("original.db");
    fs::rename(&p, &original).unwrap();
    symlink(original, p).unwrap();
    assert_eq!(i.status().await, "storage_error");
}

#[tokio::test]
async fn partial_write_preserved_and_reported() {
    let i = Instance::new();
    let (ok, output) = i.init("Admin", "long enough password", true);
    assert!(!ok);
    assert!(output.contains("partially completed"), "{output}");
    assert!(fs::read_dir(&i.database).unwrap().count() > 0);
    assert_eq!(i.status().await, "storage_error");
    assert!(!i.init("Admin", "long enough password", false).0);
}

#[tokio::test]
async fn concurrent_initializers_only_one_success() {
    let i = Instance::new();
    let barrier = std::sync::Barrier::new(2);
    let results = std::thread::scope(|s| {
        let run = || {
            barrier.wait();
            i.init("Admin", "long enough password", false).0
        };
        let a = s.spawn(run);
        let b = s.spawn(run);
        [a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(results.into_iter().filter(|ok| *ok).count(), 1);
    assert_eq!(i.status().await, "initialized");
}

/// Explicit fixture entry for browser/Compose tests; never enabled by normal cargo test.
#[test]
#[ignore = "invoked by isolated browser/container harness"]
fn initialize_external_fixture() {
    let mut cmd = CommandBuilder::new(std::env::var("FILEHOP_FIXTURE_COMMAND").unwrap());
    let args: Vec<String> =
        serde_json::from_str(&std::env::var("FILEHOP_FIXTURE_ARGS").unwrap()).unwrap();
    cmd.args(args);
    let (ok, output) = support::terminal(cmd, " synthetic password ");
    assert!(ok, "{output}");
    assert!(!output.contains("synthetic password"));
}
