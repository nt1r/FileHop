use argon2::{Argon2, PasswordHasher};
use fs2::FileExt;
use serde::Serialize;
use sqlx::{
    Connection, Row, SqliteConnection,
    sqlite::{SqliteConnectOptions, SqliteJournalMode, SqliteSynchronous},
};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Uninitialized,
    Initialized,
    StorageError,
}

type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
const ID: &str = "storage-id";
const DATABASE: &str = "transfer.db";

fn directories(database: &Path, files: &Path) -> Result<(PathBuf, PathBuf)> {
    let database = database.canonicalize()?;
    let files = files.canonicalize()?;
    if !database.is_dir()
        || !files.is_dir()
        || database.starts_with(&files)
        || files.starts_with(&database)
    {
        return Err("storage directories must be separate, accessible directories".into());
    }
    for path in [&database, &files] {
        rustix::fs::access(
            path,
            rustix::fs::Access::READ_OK
                | rustix::fs::Access::WRITE_OK
                | rustix::fs::Access::EXEC_OK,
        )?;
    }
    Ok((database, files))
}

fn empty(path: &Path) -> Result<bool> {
    Ok(fs::read_dir(path)?.next().is_none())
}

fn create(path: &Path, content: &[u8]) -> Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(content)?;
    file.sync_all()?;
    File::open(path.parent().ok_or("missing parent")?)?.sync_all()?;
    Ok(())
}

fn options(path: &Path) -> SqliteConnectOptions {
    SqliteConnectOptions::new()
        .filename(path)
        .create_if_missing(false)
        .journal_mode(SqliteJournalMode::Wal)
        .synchronous(SqliteSynchronous::Full)
        .foreign_keys(true)
}

pub async fn initialize(
    database: &Path,
    files: &Path,
    username: &str,
    password: &str,
) -> Result<()> {
    if !(3..=32).contains(&username.len())
        || !username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("username must be 3-32 ASCII letters, digits, _ or -".into());
    }
    if !(12..=128).contains(&password.chars().count()) {
        return Err("password must contain 12-128 Unicode code points".into());
    }
    let (database, files) = directories(database, files)?;
    // Directory locks create no artifacts and also serialize overlapping target pairs.
    let db_lock = File::open(&database)?;
    let files_lock = File::open(&files)?;
    db_lock.try_lock_exclusive()?;
    files_lock.try_lock_exclusive()?;
    if !empty(&database)? || !empty(&files)? {
        return Err("refusing existing or partially initialized storage".into());
    }
    let hash = Argon2::default()
        .hash_password(password.as_bytes())
        .map_err(|_| "password hashing failed")?
        .to_string();
    let id = Uuid::new_v4().to_string();
    // From here, any failure is partial initialization. Never clean up automatically.
    let result: Result<()> = async {
        create(&database.join(ID), id.as_bytes())?;
        create(&files.join(ID), id.as_bytes())?;
        create(&database.join(DATABASE), &[])?;
        let mut connection =
            SqliteConnection::connect_with(&options(&database.join(DATABASE))).await?;
        sqlx::migrate!("./migrations").run(&mut connection).await?;
        let mut transaction = connection.begin().await?;
        sqlx::query("INSERT INTO instance VALUES (1, ?)")
            .bind(&id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query("INSERT INTO account VALUES (1, ?, ?)")
            .bind(username.to_ascii_lowercase())
            .bind(hash)
            .execute(&mut *transaction)
            .await?;
        transaction.commit().await?;
        connection.close().await?;
        File::open(&database)?.sync_all()?;
        Ok(())
    }
    .await;
    result.map_err(|_| "initialization partially completed; preserve both directories and inspect them manually; no automatic cleanup performed".into())
}

pub async fn inspect(database: &Path, files: &Path) -> Status {
    match inspect_inner(database, files).await {
        Ok(state) => state,
        Err(_) => Status::StorageError,
    }
}

async fn inspect_inner(database: &Path, files: &Path) -> Result<Status> {
    let (database, files) = directories(database, files)?;
    let db_lock = File::open(&database)?;
    let files_lock = File::open(&files)?;
    FileExt::try_lock_shared(&db_lock)?;
    FileExt::try_lock_shared(&files_lock)?;
    if empty(&database)? && empty(&files)? {
        return Ok(Status::Uninitialized);
    }
    // No create or migration on ordinary startup. Refuse symlinked required files.
    for path in [database.join(ID), files.join(ID), database.join(DATABASE)] {
        if !fs::symlink_metadata(path)?.file_type().is_file() {
            return Err("invalid storage file".into());
        }
    }
    // Check write access without creating a replacement database or modifying content.
    OpenOptions::new()
        .write(true)
        .open(database.join(DATABASE))?;
    let id = fs::read_to_string(database.join(ID))?;
    Uuid::parse_str(&id)?;
    if fs::read_to_string(files.join(ID))? != id {
        return Err("storage identity mismatch".into());
    }
    let mut connection =
        SqliteConnection::connect_with(&options(&database.join(DATABASE)).read_only(true)).await?;
    let stored: String = sqlx::query_scalar("SELECT storage_id FROM instance WHERE singleton = 1")
        .fetch_one(&mut connection)
        .await?;
    if stored != id {
        return Err("database identity mismatch".into());
    }
    let row = sqlx::query("SELECT username, password_hash FROM account WHERE singleton = 1")
        .fetch_one(&mut connection)
        .await?;
    let hash: String = row.try_get("password_hash")?;
    if !hash.starts_with("$argon2id$") {
        return Err("invalid password hash".into());
    }
    connection.close().await?;
    Ok(Status::Initialized)
}
