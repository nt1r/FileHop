use crate::session::{Service, authenticate, error, unavailable, write_origin_allowed};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use futures_util::TryStreamExt;
use serde::Deserialize;
use sqlx::{Connection, SqliteConnection};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};

#[derive(Clone)]
pub struct TransferConfig {
    pub max_file_size: i64,
    pub quota: i64,
    pub prepare_timeout: Duration,
    pub idle_timeout: Duration,
    pub total_timeout: Duration,
    pub download_idle_timeout: Duration,
    pub active_limit: usize,
    pub disk_reserve: u64,
}
impl Default for TransferConfig {
    fn default() -> Self {
        Self {
            max_file_size: 104_857_600,
            quota: 1_073_741_824,
            prepare_timeout: Duration::from_secs(120),
            idle_timeout: Duration::from_secs(120),
            total_timeout: Duration::from_secs(1800),
            download_idle_timeout: Duration::from_secs(120),
            active_limit: 8,
            disk_reserve: 64 * 1024 * 1024,
        }
    }
}
pub(crate) struct Transfers {
    pub gate: Mutex<()>,
    pub slots: Arc<Semaphore>,
    pub preparations: Arc<Semaphore>,
    pub downloads: Arc<Semaphore>,
    pub ready: std::sync::atomic::AtomicBool,
    pub writers: std::sync::Mutex<std::collections::HashMap<String, usize>>,
    pub cleanup_cursor: std::sync::Mutex<Option<String>>,
}
impl Transfers {
    pub fn new(limit: usize) -> Self {
        Self {
            gate: Mutex::new(()),
            slots: Arc::new(Semaphore::new(limit)),
            preparations: Arc::new(Semaphore::new(limit)),
            downloads: Arc::new(Semaphore::new(limit)),
            ready: std::sync::atomic::AtomicBool::new(false),
            writers: std::sync::Mutex::new(std::collections::HashMap::new()),
            cleanup_cursor: std::sync::Mutex::new(None),
        }
    }
}
use tokio::{
    fs::{self, OpenOptions},
    io::AsyncWriteExt,
};
use uuid::Uuid;

fn json(status: StatusCode, value: impl serde::Serialize) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
fn id(raw: &str) -> Option<String> {
    Uuid::parse_str(raw).ok().map(|v| v.to_string())
}
fn paths(service: &Service, file_id: &str) -> (PathBuf, PathBuf) {
    (
        service.files.join(format!("{file_id}.partial")),
        service.files.join(file_id),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepare {
    send_id: String,
    attempt_id: String,
    name: String,
    size: i64,
    mime: String,
    source_label: String,
}

// 仅在没有本进程写入者的状态回收；失败时保留额度，下一次准备或启动继续清理。
async fn cleanup(service: &Service, db: &mut SqliteConnection, send: &str, file_id: &str) -> bool {
    let (temp, final_path) = paths(service, file_id);
    let mut cleared = true;
    for path in [temp, final_path] {
        match fs::remove_file(&path).await {
            Ok(()) => {
                if let Ok(dir) = std::fs::File::open(&service.files) {
                    if dir.sync_all().is_err() {
                        cleared = false;
                    }
                } else {
                    cleared = false;
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => cleared = false,
        }
    }
    // 即使实体已不存在，也须先同步目录再释放额度：上次删除可能尚未可靠落盘。
    if std::fs::File::open(&service.files)
        .and_then(|dir| dir.sync_all())
        .is_err()
    {
        cleared = false;
    }
    if cleared {
        let mut tx = match db.begin().await {
            Ok(tx) => tx,
            Err(_) => return false,
        };
        if sqlx::query(
            "UPDATE file_send SET state=CASE WHEN EXISTS (SELECT 1 FROM file_attempt_marker WHERE attempt_id=file_send.attempt_id AND stopped=1) THEN 'stopped' ELSE 'failed' END,reserved=0 WHERE send_id=? AND state='cleaning'",
        )
        .bind(send)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return false;
        }
        if sqlx::query(
            "UPDATE file_attempt SET state=CASE WHEN EXISTS (SELECT 1 FROM file_attempt_marker WHERE attempt_id=file_attempt.attempt_id AND stopped=1) THEN 'stopped' ELSE 'failed' END WHERE send_id=? AND state IN ('prepared','writing','cleaning')",
        )
        .bind(send)
        .execute(&mut *tx)
        .await
        .is_err()
        {
            return false;
        }
        tx.commit().await.is_ok()
    } else {
        false
    }
}
pub(crate) async fn reconcile(
    service: &Service,
    db: &mut SqliteConnection,
) -> Result<(), Box<Response>> {
    let now = (service.config.now)();
    // 每轮只扫描有限记录，并从上轮游标继续；受保护的写入者或清理失败
    // 不能占住固定第一页，阻止后续实体回收。
    let cursor = service.transfers.cleanup_cursor.lock().unwrap().clone();
    let mut rows = cleanup_rows(
        db,
        now,
        service.config.transfer.prepare_timeout,
        cursor.as_deref(),
    )
    .await?;
    if rows.is_empty() && cursor.is_some() {
        *service.transfers.cleanup_cursor.lock().unwrap() = None;
        rows = cleanup_rows(db, now, service.config.transfer.prepare_timeout, None).await?;
    }
    if let Some((send, _, _)) = rows.last() {
        *service.transfers.cleanup_cursor.lock().unwrap() = Some(send.clone());
    }
    let mut cleanup_failed = false;
    for (send, file, state) in rows {
        if state == "cleaning"
            && service
                .transfers
                .writers
                .lock()
                .unwrap()
                .contains_key(&send)
        {
            continue;
        }
        if state == "writing" {
            // 进程内仍有写入者时不碰实体；只有任务退出（包括 panic）才能接管清理。
            if service
                .transfers
                .writers
                .lock()
                .unwrap()
                .contains_key(&send)
            {
                continue;
            }
            let mut tx = db.begin().await.map_err(|_| Box::new(unavailable()))?;
            let changed = sqlx::query(
                "UPDATE file_send SET state='cleaning' WHERE send_id=? AND state='writing'",
            )
            .bind(&send)
            .execute(&mut *tx)
            .await
            .map_err(|_| Box::new(unavailable()))?;
            if changed.rows_affected() == 0 {
                continue;
            }
            sqlx::query(
                "UPDATE file_attempt SET state='cleaning' WHERE send_id=? AND state='writing'",
            )
            .bind(&send)
            .execute(&mut *tx)
            .await
            .map_err(|_| Box::new(unavailable()))?;
            tx.commit().await.map_err(|_| Box::new(unavailable()))?;
        }
        if state == "prepared" {
            // 查询到已超时并不意味着仍可清理：PUT 可能在查询后抢先取得写入资格。
            // 两个状态须在同一事务裁决，提交后才能碰磁盘和释放预留。
            let mut tx = db.begin().await.map_err(|_| Box::new(unavailable()))?;
            let changed = sqlx::query("UPDATE file_send SET state='cleaning' WHERE send_id=? AND state='prepared' AND prepared_at <= ?")
                .bind(&send).bind(now - service.config.transfer.prepare_timeout.as_secs() as i64)
                .execute(&mut *tx).await.map_err(|_| Box::new(unavailable()))?;
            if changed.rows_affected() == 0 {
                continue;
            }
            sqlx::query(
                "UPDATE file_attempt SET state='cleaning' WHERE send_id=? AND state='prepared'",
            )
            .bind(&send)
            .execute(&mut *tx)
            .await
            .map_err(|_| Box::new(unavailable()))?;
            tx.commit().await.map_err(|_| Box::new(unavailable()))?;
        }
        if !cleanup(service, db, &send, &file).await {
            // 一个坏实体不应饿死本轮其他待清理任务；仍将失败传给后台退避。
            cleanup_failed = true;
        }
    }
    if cleanup_failed {
        Err(Box::new(unavailable()))
    } else {
        Ok(())
    }
}
async fn cleanup_rows(
    db: &mut SqliteConnection,
    now: i64,
    prepare_timeout: Duration,
    cursor: Option<&str>,
) -> Result<Vec<(String, String, String)>, Box<Response>> {
    let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new(
        "SELECT send_id,file_id,state FROM file_send WHERE (state IN ('cleaning','writing') OR (state='prepared' AND prepared_at <= ",
    );
    query.push_bind(now - prepare_timeout.as_secs() as i64);
    query.push("))");
    if let Some(cursor) = cursor {
        query.push(" AND send_id > ").push_bind(cursor);
    }
    query
        .push(" ORDER BY send_id LIMIT 64")
        .build_query_as()
        .fetch_all(db)
        .await
        .map_err(|_| Box::new(unavailable()))
}
// 进程启动时，在开放 HTTP 写入口之前裁决所有遗留写入；已成功的消息永不补写或删除。
pub async fn recover(
    database: &std::path::Path,
    files: &std::path::Path,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    match crate::storage::inspect(database, files).await {
        crate::storage::Status::Initialized => (),
        crate::storage::Status::Uninitialized => return Ok(()),
        crate::storage::Status::StorageError => {
            return Err("storage unavailable; recovery refused".into());
        }
    }
    let mut db =
        SqliteConnection::connect_with(&crate::storage::options(&database.join("transfer.db")))
            .await?;
    // 未提交请求在重启时一律失败；真正成功的提交已在 SQLite 中标记为 success。
    let mut tx = db.begin().await?;
    sqlx::query("UPDATE file_send SET state='cleaning' WHERE state IN ('writing','prepared')")
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE file_attempt SET state='cleaning' WHERE state IN ('writing','prepared')")
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let service = Service::for_recovery(database.to_path_buf(), files.to_path_buf());
    // 协调函数每轮最多处理 64 条，启动前必须排空遗留记录。
    loop {
        reconcile(&service, &mut db)
            .await
            .map_err(|_| "recovery failed")?;
        let pending: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM file_send WHERE state='cleaning'")
                .fetch_one(&mut db)
                .await?;
        if pending == 0 {
            break;
        }
    }
    // 只有由本应用安全 UUID 命名的文件才参与协调；未知目录项不擅自删除。
    // 数据库中已有成功记录即使实体缺失也保留历史及额度，下载再如实报告存储异常。
    for entry in std::fs::read_dir(files)? {
        let entry = entry?;
        let filename = entry.file_name();
        let Some(raw) = filename.to_str() else {
            continue;
        };
        let raw = raw.strip_suffix(".partial").unwrap_or(raw);
        let Some(file_id) = id(raw) else {
            continue;
        };
        // 仅接管精确的受管实体名；不同大小写或其他拼写不能被规范化后误删。
        if raw != file_id {
            continue;
        }
        let row: Option<(String, String)> =
            sqlx::query_as("SELECT send_id,state FROM file_send WHERE file_id=?")
                .bind(&file_id)
                .fetch_optional(&mut db)
                .await?;
        if row.as_ref().is_some_and(|(_, state)| state == "success") {
            // 只利用既有启动目录遍历发现明显异常，不新增扫描或 Hash 校验。
            // 成功发送的临时残留不代表正式实体异常，也不能擅自删除。
            if filename.to_str() == Some(file_id.as_str()) {
                let size: i64 = sqlx::query_scalar("SELECT size FROM file_send WHERE file_id=?")
                    .bind(&file_id)
                    .fetch_one(&mut db)
                    .await?;
                let meta = std::fs::symlink_metadata(entry.path())?;
                if !meta.is_file() || meta.len() != size as u64 {
                    persist_storage_error(&service, &mut db, &file_id)
                        .await
                        .map_err(|_| "storage anomaly could not be recorded")?;
                }
            }
            continue;
        }
        if !entry.file_type()?.is_file() {
            continue;
        }
        if let Some((send, _)) = row {
            let mut tx = db.begin().await?;
            sqlx::query(
                "UPDATE file_send SET state='cleaning' WHERE send_id=? AND state!='success'",
            )
            .bind(&send)
            .execute(&mut *tx)
            .await?;
            sqlx::query("UPDATE file_attempt SET state='cleaning' WHERE send_id=? AND state IN ('prepared','writing')")
                .bind(&send).execute(&mut *tx).await?;
            tx.commit().await?;
            if !cleanup(&service, &mut db, &send, &file_id).await {
                return Err("recovery cleanup failed".into());
            }
        } else {
            // 无数据库预留可释放；删除失败保持文件占用磁盘，阻止启动直至人工排障。
            match fs::remove_file(entry.path()).await {
                Ok(()) => std::fs::File::open(files)?.sync_all()?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                Err(e) => return Err(e.into()), // 无预留的残留仍占空间，无法清理时不开放新上传。
            }
        }
    }
    Ok(())
}
pub(crate) async fn storage(State(service): State<Arc<Service>>, headers: HeaderMap) -> Response {
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(value) => value,
        Err(e) => return *e,
    };
    // 一条 SELECT 读取同一数据库快照，避免提交或清理恰好发生在分类查询之间，
    // 导致同一份预留被重复计入或遗漏。临时文件已经包含在完整预留中，不另扫磁盘。
    let usage: Result<(i64, i64, i64), _> = sqlx::query_as(
        "SELECT COALESCE(SUM(CASE WHEN state='success' THEN reserved ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN state IN ('prepared','writing') THEN reserved ELSE 0 END),0),
                COALESCE(SUM(CASE WHEN state='cleaning' THEN reserved ELSE 0 END),0)
         FROM file_send",
    )
    .fetch_one(&mut db)
    .await;
    let (saved, reserved, cleaning) = match usage {
        Ok(value) => value,
        Err(_) => return unavailable(),
    };
    let quota = service.config.transfer.quota;
    let used = i128::from(saved) + i128::from(reserved) + i128::from(cleaning);
    json(
        StatusCode::OK,
        serde_json::json!({
            "quota_bytes": quota.to_string(),
            "saved_bytes": saved.to_string(),
            "reserved_bytes": reserved.to_string(),
            "cleaning_bytes": cleaning.to_string(),
            "available_bytes": (i128::from(quota) - used).max(0).to_string(),
            "over_quota": used > i128::from(quota),
        }),
    )
}

pub(crate) async fn limits(State(service): State<Arc<Service>>, headers: HeaderMap) -> Response {
    if let Err(e) = authenticate(&service, &headers).await {
        return *e;
    }
    json(
        StatusCode::OK,
        serde_json::json!({
            "max_file_size_bytes":service.config.transfer.max_file_size,
            "upload_total_timeout_seconds":service.config.transfer.total_timeout.as_secs(),
        }),
    )
}
pub(crate) async fn prepare(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    // 准备阶段从鉴权、读取请求体开始限流，慢请求不能绕过准入队列。
    let _permit = match service.transfers.preparations.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "transfer_busy",
                "准备请求过多",
            );
        }
    };
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .map(str::trim)
        .is_none_or(|v| !v.eq_ignore_ascii_case("application/json"))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "json_required",
            "请求必须使用 JSON",
        );
    }
    let bytes = match tokio::time::timeout(Duration::from_secs(15), to_bytes(body, 8192)).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large", "请求过大"),
        Err(_) => {
            return error(
                StatusCode::REQUEST_TIMEOUT,
                "request_timeout",
                "准备请求超时",
            );
        }
    };
    let p: Prepare = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_json", "无效元数据"),
    };
    let (Some(send), Some(attempt)) = (id(&p.send_id), id(&p.attempt_id)) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_id", "无效标识");
    };
    let source_label = p.source_label.trim_matches(crate::messages::whitespace);
    if p.size < 0
        || p.name.is_empty()
        || p.name.len() > 1024
        || p.name.contains('\0')
        || p.mime.len() > 255
        || !(1..=64).contains(&source_label.chars().count())
    {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_metadata",
            "无效文件元数据或文件过大",
        );
    }
    if !service
        .transfers
        .ready
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return unavailable();
    }
    let _guard = match service.transfers.gate.try_lock() {
        Ok(g) => g,
        Err(_) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "transfer_busy",
                "准备请求过多",
            );
        }
    };
    if let Err(e) = reconcile(&service, &mut db).await {
        return *e;
    }
    let result: Result<(String, String), sqlx::Error> = async {
        let mut tx = db.begin().await?;
        // 先取得写锁，再核算已提交与未提交的占用；不能让并发读到同一份剩余额度。
        sqlx::query("UPDATE instance SET storage_id=storage_id WHERE singleton=1")
            .execute(&mut *tx)
            .await?;
        let existing: Option<(String, i64, String, String, String)> = sqlx::query_as(
            "SELECT name,size,mime,source_label,state FROM file_send WHERE send_id=?",
        )
        .bind(&send)
        .fetch_optional(&mut *tx)
        .await?;
        let state = if let Some((name, size, mime, label, state)) = existing {
            if name != p.name || size != p.size || mime != p.mime || label != source_label {
                return Err(sqlx::Error::RowNotFound);
            }
            let attempt_state = sqlx::query_scalar::<_, String>(
                "SELECT state FROM file_attempt WHERE attempt_id=? AND send_id=?",
            )
            .bind(&attempt)
            .bind(&send)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(sqlx::Error::RowNotFound)?;
            // 同一标识只重放原尝试的状态，不再次预留或激活已经终结的尝试。
            if attempt_state == "failed" || attempt_state == "cleaning" || attempt_state == "stopped" {
                return Ok((attempt_state, attempt));
            }
            if attempt_state != state {
                return Err(sqlx::Error::RowNotFound);
            }
            state
        } else {
            if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM message WHERE send_id=?")
                .bind(&send).fetch_one(&mut *tx).await? != 0 { return Err(sqlx::Error::RowNotFound) }
            // 已被首次尝试占用的发送身份不能再被另一首次准备抢走；
            // 后继的停止标记尚不决定首次文件元数据。
            if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM file_attempt_marker WHERE send_id=? AND attempt_id!=? AND is_first=1")
                .bind(&send).bind(&attempt).fetch_one(&mut *tx).await? != 0 { return Err(sqlx::Error::RowNotFound) }
            // 迟到准备不得使已持久停止的身份重新激活，也不能凭停止标记猜出元数据。
            let stopped: Option<(String, Option<String>, i64)> = sqlx::query_as("SELECT send_id,previous_attempt_id,stopped FROM file_attempt_marker WHERE attempt_id=?")
                .bind(&attempt).fetch_optional(&mut *tx).await?;
            if let Some((owner, predecessor, stopped)) = stopped {
                if owner != send || predecessor.is_some() { return Err(sqlx::Error::RowNotFound) }
                if stopped != 1 { return Err(sqlx::Error::RowNotFound) }
                sqlx::query("UPDATE file_attempt_marker SET is_first=1 WHERE attempt_id=?")
                    .bind(&attempt).execute(&mut *tx).await?;
                tx.commit().await?;
                return Ok(("stopped".into(), attempt));
            }
            // SQLite 的写事务将额度核算与申请串行化；失败不会留下半条预留。
            if p.size > service.config.transfer.max_file_size {
                tx.rollback().await?;
                return Ok(("file_too_large".into(), String::new()));
            }
            // 未开始任务与永久发送身份都消耗存储：既限同时未开始数，
            // 也限每小时新建记录数，避免零字节申请在不断过期后无限速增长。
            let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_send WHERE state='prepared' OR prepared_at >= strftime('%s','now') - 3600")
                .fetch_one(&mut *tx).await?;
            if pending >= 64 {
                tx.rollback().await?;
                return Ok(("transfer_busy".into(), String::new()));
            }
            let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(reserved),0) FROM file_send")
                .fetch_one(&mut *tx)
                .await?;
            if p.size > service.config.transfer.quota
                || used > service.config.transfer.quota - p.size
            {
                tx.rollback().await?;
                return Ok(("quota_exceeded".into(), String::new()));
            }
            let available = fs2::available_space(&service.files).map_err(sqlx::Error::Io)?;
            if available < (p.size as u64).saturating_add(service.config.transfer.disk_reserve) {
                tx.rollback().await?;
                return Ok(("disk_full".into(), String::new()));
            }
            if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM file_attempt WHERE attempt_id=?")
                .bind(&attempt)
                .fetch_one(&mut *tx)
                .await?
                != 0
            {
                return Err(sqlx::Error::RowNotFound);
            }
            let file = Uuid::new_v4().to_string();
            sqlx::query("INSERT INTO file_attempt_marker (attempt_id,send_id,is_first,stopped) VALUES (?,?,1,0)")
                .bind(&attempt).bind(&send).execute(&mut *tx).await?;
            sqlx::query(
                "INSERT INTO file_send VALUES (?,?,?,?,?,?,?, 'prepared', ?, strftime('%s','now'))",
            )
            .bind(&send)
            .bind(&attempt)
            .bind(&file)
            .bind(&p.name)
            .bind(p.size)
            .bind(&p.mime)
            .bind(source_label)
            .bind(p.size)
            .execute(&mut *tx)
            .await?;
            sqlx::query(
                "INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,'prepared')",
            )
            .bind(&attempt)
            .bind(&send)
            .execute(&mut *tx)
            .await?;
            "prepared".into()
        };
        tx.commit().await?;
        Ok((state, attempt))
    }
    .await;
    match result {
        Ok((state, _)) if state == "file_too_large" => error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "文件超过上限",
        ),
        Ok((state, _)) if state == "transfer_busy" => error(
            StatusCode::TOO_MANY_REQUESTS,
            "transfer_busy",
            "未开始的传输过多",
        ),
        Ok((state, _)) if state == "disk_full" => error(
            StatusCode::INSUFFICIENT_STORAGE,
            "disk_full",
            "磁盘空间不足",
        ),
        Ok((state, _)) if state == "quota_exceeded" => {
            error(StatusCode::CONFLICT, "quota_exceeded", "文件空间不足")
        }
        Ok((state, _)) if state == "success" => crate::messages::committed(&mut db, &send).await,
        Ok((state, attempt_id)) => json(
            StatusCode::OK,
            serde_json::json!({"state":state,"send_id":send,"attempt_id":attempt_id}),
        ),
        Err(sqlx::Error::RowNotFound) => {
            error(StatusCode::CONFLICT, "send_conflict", "发送标识已使用")
        }
        Err(_) => unavailable(),
    }
}

// 查询的是发送及当前尝试，不是“有没有成功消息”；未找到成功结果不能证明尚未开始写入。
pub(crate) async fn send_status(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Path(send): Path<String>,
) -> Response {
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    let Some(send) = id(&send) else {
        return error(StatusCode::NOT_FOUND, "send_not_found", "发送不存在");
    };
    let row: Option<(String, String)> =
        match sqlx::query_as("SELECT state,attempt_id FROM file_send WHERE send_id=?")
            .bind(&send)
            .fetch_optional(&mut db)
            .await
        {
            Ok(v) => v,
            Err(_) => return unavailable(),
        };
    let Some((state, attempt)) = row else {
        // 文件元数据还未登记时，只能报告明确的单个停止标记；
        // 多个预先到达的停止身份没有前驱顺序，不能猜哪个是当前尝试。
        let markers: Vec<String> = match sqlx::query_scalar(
            "SELECT attempt_id FROM file_attempt_marker WHERE send_id=? AND stopped=1 LIMIT 2",
        )
        .bind(&send)
        .fetch_all(&mut db)
        .await
        {
            Ok(v) => v,
            Err(_) => return unavailable(),
        };
        return match markers.as_slice() {
            [attempt] => json(
                StatusCode::OK,
                serde_json::json!({"state":"stopped","send_id":send,"attempt_id":attempt}),
            ),
            _ => error(StatusCode::NOT_FOUND, "send_not_found", "发送不存在"),
        };
    };
    if state == "success" {
        let response = crate::messages::committed(&mut db, &send).await;
        if response.status() != StatusCode::OK {
            return response;
        }
        let bytes = match to_bytes(response.into_body(), 8192).await {
            Ok(b) => b,
            Err(_) => return unavailable(),
        };
        let message: serde_json::Value = match serde_json::from_slice(&bytes) {
            Ok(v) => v,
            Err(_) => return unavailable(),
        };
        return json(
            StatusCode::OK,
            serde_json::json!({"state":state,"send_id":send,"attempt_id":attempt,"message":message}),
        );
    }
    let stop_requested = if state == "cleaning" {
        match sqlx::query_scalar::<_, i64>(
            "SELECT COUNT(*) FROM file_attempt_marker WHERE attempt_id=? AND stopped=1",
        )
        .bind(&attempt)
        .fetch_one(&mut db)
        .await
        {
            Ok(count) => count != 0,
            Err(_) => return unavailable(),
        }
    } else {
        false
    };
    json(
        StatusCode::OK,
        serde_json::json!({"state":state,"send_id":send,"attempt_id":attempt,"stop_requested":stop_requested}),
    )
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct NextAttempt {
    attempt_id: String,
    previous_attempt_id: String,
    // 首次准备可能从未登记元数据；此时后继补齐固定载荷。
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    size: Option<i64>,
    #[serde(default)]
    mime: Option<String>,
    #[serde(default)]
    source_label: Option<String>,
}

pub(crate) async fn successor(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Path(send): Path<String>,
    body: Body,
) -> Response {
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    // 与首次准备共用鉴权后的有界读取：未授权及慢请求不能无界消耗解析资源。
    let _permit = match service.transfers.preparations.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "transfer_busy",
                "准备请求过多",
            );
        }
    };
    let bytes = match tokio::time::timeout(Duration::from_secs(15), to_bytes(body, 8192)).await {
        Ok(Ok(v)) => v,
        Ok(Err(_)) => return error(StatusCode::PAYLOAD_TOO_LARGE, "body_too_large", "请求过大"),
        Err(_) => {
            return error(
                StatusCode::REQUEST_TIMEOUT,
                "request_timeout",
                "准备请求超时",
            );
        }
    };
    let next: NextAttempt = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_json", "无效尝试元数据"),
    };
    let (Some(send), Some(attempt), Some(previous)) = (
        id(&send),
        id(&next.attempt_id),
        id(&next.previous_attempt_id),
    ) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_id", "无效标识");
    };
    if attempt == previous {
        return error(StatusCode::CONFLICT, "attempt_conflict", "传输尝试不匹配");
    }
    if !service
        .transfers
        .ready
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return unavailable();
    }
    let _guard = match service.transfers.gate.try_lock() {
        Ok(g) => g,
        Err(_) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "transfer_busy",
                "准备请求过多",
            );
        }
    };
    if let Err(e) = reconcile(&service, &mut db).await {
        return *e;
    }
    let result: Result<String, sqlx::Error> = async {
        let mut tx = db.begin().await?;
        // 写锁让前驱检查、额度核算、后继创建成为同一个裁决；旧请求不能与新尝试争用实体。
        sqlx::query("UPDATE instance SET storage_id=storage_id WHERE singleton=1").execute(&mut *tx).await?;
        let row: Option<(String, String, i64)> = sqlx::query_as("SELECT state,attempt_id,size FROM file_send WHERE send_id=?")
            .bind(&send).fetch_optional(&mut *tx).await?;
        let Some((state, current, size)) = row else {
            // 纯停止标记没有文件元数据；首次真正准备由后继请求补齐并锁定。
            let owner: Option<String> = sqlx::query_scalar("SELECT send_id FROM file_attempt_marker WHERE attempt_id=?")
                .bind(&previous).fetch_optional(&mut *tx).await?;
            if owner.as_deref() != Some(&send) { return Ok("not_found".into()) }
            let (Some(name), Some(size), Some(mime), Some(label)) = (&next.name, next.size, &next.mime, &next.source_label) else { return Ok("invalid_metadata".into()) };
            let label = label.trim_matches(crate::messages::whitespace);
            if name.is_empty() || name.len() > 1024 || name.contains('\0') || size < 0 || mime.len() > 255 || !(1..=64).contains(&label.chars().count()) { return Ok("invalid_metadata".into()) }
            if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM message WHERE send_id=?").bind(&send).fetch_one(&mut *tx).await? != 0 { return Ok("conflict".into()) }
            let existing: Option<(String, Option<String>)> = sqlx::query_as("SELECT send_id,previous_attempt_id FROM file_attempt_marker WHERE attempt_id=?")
                .bind(&attempt).fetch_optional(&mut *tx).await?;
            if existing.as_ref().is_some_and(|(owner, prev)| owner != &send || prev.as_deref().is_some_and(|v| v != previous)) { return Ok("conflict".into()) }
            let sibling: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attempt_marker WHERE send_id=? AND previous_attempt_id=? AND attempt_id!=?")
                .bind(&send).bind(&previous).bind(&attempt).fetch_one(&mut *tx).await?;
            if sibling != 0 { return Ok("conflict".into()) }
            if existing.is_some() {
                // 后继停止先到也须记录唯一前驱，不要求它先申请额度。
                sqlx::query("UPDATE file_attempt_marker SET previous_attempt_id=? WHERE attempt_id=? AND previous_attempt_id IS NULL")
                    .bind(&previous).bind(&attempt).execute(&mut *tx).await?;
                let file = Uuid::new_v4().to_string();
                sqlx::query("INSERT INTO file_send VALUES (?,?,?,?,?,?,?,?,?,strftime('%s','now'))")
                    .bind(&send).bind(&attempt).bind(&file).bind(name).bind(size).bind(mime).bind(label).bind("stopped").bind(0)
                    .execute(&mut *tx).await?;
                sqlx::query("INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,'stopped')")
                    .bind(&previous).bind(&send).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,'stopped')")
                    .bind(&attempt).bind(&send).execute(&mut *tx).await?;
                tx.commit().await?;
                return Ok("stopped".into());
            }
            if size > service.config.transfer.max_file_size { return Ok("file_too_large".into()) }
            let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_send WHERE state='prepared' OR prepared_at >= strftime('%s','now') - 3600")
                .fetch_one(&mut *tx).await?;
            if pending >= 64 { return Ok("busy_limit".into()) }
            let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(reserved),0) FROM file_send").fetch_one(&mut *tx).await?;
            if size > service.config.transfer.quota || used > service.config.transfer.quota - size { return Ok("quota_exceeded".into()) }
            let available = fs2::available_space(&service.files).map_err(sqlx::Error::Io)?;
            if available < (size as u64).saturating_add(service.config.transfer.disk_reserve) { return Ok("disk_full".into()) }
            sqlx::query("INSERT INTO file_attempt_marker (attempt_id,send_id,previous_attempt_id,stopped) VALUES (?,?,?,0)")
                .bind(&attempt).bind(&send).bind(&previous).execute(&mut *tx).await?;
            let file = Uuid::new_v4().to_string();
            let state = "prepared";
            sqlx::query("INSERT INTO file_send VALUES (?,?,?,?,?,?,?,?,?,strftime('%s','now'))")
                .bind(&send).bind(&attempt).bind(&file).bind(name).bind(size).bind(mime).bind(label).bind(state).bind(size)
                .execute(&mut *tx).await?;
            sqlx::query("INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,'stopped')")
                .bind(&previous).bind(&send).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,?)")
                .bind(&attempt).bind(&send).bind(state).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok(state.into());
        };
        if state == "success" { return Ok(state) }
        let metadata: (String, i64, String, String) = sqlx::query_as("SELECT name,size,mime,source_label FROM file_send WHERE send_id=?")
            .bind(&send).fetch_one(&mut *tx).await?;
        if next.name.as_ref().is_some_and(|v| v != &metadata.0)
            || next.size.is_some_and(|v| v != metadata.1)
            || next.mime.as_ref().is_some_and(|v| v != &metadata.2)
            || next.source_label.as_ref().is_some_and(|v| v.trim_matches(crate::messages::whitespace) != metadata.3)
        { return Ok("conflict".into()) }
        let replay: Option<String> = sqlx::query_scalar("SELECT state FROM file_attempt WHERE attempt_id=? AND send_id=?")
            .bind(&attempt).bind(&send).fetch_optional(&mut *tx).await?;
        if let Some(replay) = replay { return Ok(replay) }
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM file_attempt_marker WHERE attempt_id=? AND send_id!=?")
            .bind(&attempt).bind(&send).fetch_one(&mut *tx).await? != 0 { return Ok("conflict".into()) }
        if current != previous { return Ok("conflict".into()) }
        if state != "failed" && state != "stopped" { return Ok("busy".into()) }
        let existing: Option<(String, Option<String>)> = sqlx::query_as("SELECT send_id,previous_attempt_id FROM file_attempt_marker WHERE attempt_id=?")
            .bind(&attempt).fetch_optional(&mut *tx).await?;
        if existing.as_ref().is_some_and(|(owner, prev)| owner != &send || prev.as_deref().is_some_and(|v| v != previous)) { return Ok("conflict".into()) }
        let sibling: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attempt_marker WHERE send_id=? AND previous_attempt_id=? AND attempt_id!=?")
            .bind(&send).bind(&previous).bind(&attempt).fetch_one(&mut *tx).await?;
        if sibling != 0 { return Ok("conflict".into()) }
        if existing.is_some() {
            // 已持久停止的后继只能作为终结身份登记；没有额度申请或写入资格。
            sqlx::query("UPDATE file_attempt_marker SET previous_attempt_id=? WHERE attempt_id=? AND previous_attempt_id IS NULL")
                .bind(&previous).bind(&attempt).execute(&mut *tx).await?;
            sqlx::query("UPDATE file_send SET attempt_id=?,state='stopped',reserved=0 WHERE send_id=? AND attempt_id=? AND state IN ('failed','stopped')")
                .bind(&attempt).bind(&send).bind(&previous).execute(&mut *tx).await?;
            sqlx::query("INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,'stopped')")
                .bind(&attempt).bind(&send).execute(&mut *tx).await?;
            tx.commit().await?;
            return Ok("stopped".into());
        }
        if size > service.config.transfer.max_file_size { return Ok("file_too_large".into()) }
        let pending: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_send WHERE state='prepared' OR prepared_at >= strftime('%s','now') - 3600")
            .fetch_one(&mut *tx).await?;
        if pending >= 64 { return Ok("busy_limit".into()) }
        let used: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(reserved),0) FROM file_send")
            .fetch_one(&mut *tx).await?;
        if size > service.config.transfer.quota || used > service.config.transfer.quota - size { return Ok("quota_exceeded".into()) }
        let available = fs2::available_space(&service.files).map_err(sqlx::Error::Io)?;
        if available < (size as u64).saturating_add(service.config.transfer.disk_reserve) { return Ok("disk_full".into()) }
        let taken: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attempt WHERE attempt_id=?").bind(&attempt).fetch_one(&mut *tx).await?;
        if taken != 0 { return Ok("conflict".into()) }
        // 已停止的后继可能先于准备登记；只能在同一前驱上重放，不能新造第三次尝试。
        let marker: Option<(String, Option<String>)> = sqlx::query_as("SELECT send_id,previous_attempt_id FROM file_attempt_marker WHERE attempt_id=?")
            .bind(&attempt).fetch_optional(&mut *tx).await?;
        if marker.as_ref().is_some_and(|(owner, prev)| owner != &send || prev.as_deref().is_some_and(|v| v != previous)) { return Ok("conflict".into()) }
        let sibling: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attempt_marker WHERE send_id=? AND previous_attempt_id=? AND attempt_id!=?")
            .bind(&send).bind(&previous).bind(&attempt).fetch_one(&mut *tx).await?;
        if sibling != 0 { return Ok("conflict".into()) }
        // 每次重传使用新实体；旧实体即使迟到也只属于旧尝试，不会被复用。
        let file = Uuid::new_v4().to_string();
        sqlx::query("UPDATE file_send SET attempt_id=?,file_id=?,state='prepared',reserved=size,prepared_at=strftime('%s','now') WHERE send_id=? AND attempt_id=? AND state IN ('failed','stopped')")
            .bind(&attempt).bind(&file).bind(&send).bind(&previous).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO file_attempt (attempt_id,send_id,state) VALUES (?,?,'prepared')")
            .bind(&attempt).bind(&send).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok("prepared".into())
    }.await;
    match result {
        Ok(state) if state == "success" => crate::messages::committed(&mut db, &send).await,
        Ok(state) if state == "invalid_metadata" => error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_metadata",
            "无效文件元数据",
        ),
        Ok(state) if state == "not_found" => {
            error(StatusCode::NOT_FOUND, "send_not_found", "发送不存在")
        }
        Ok(state) if state == "conflict" => {
            error(StatusCode::CONFLICT, "attempt_conflict", "传输尝试不匹配")
        }
        Ok(state) if state == "busy_limit" => error(
            StatusCode::TOO_MANY_REQUESTS,
            "transfer_busy",
            "准备请求过多",
        ),
        Ok(state) if state == "busy" => {
            error(StatusCode::CONFLICT, "attempt_busy", "尝试仍在进行或清理中")
        }
        Ok(state) if state == "file_too_large" => error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "file_too_large",
            "文件超过上限",
        ),
        Ok(state) if state == "quota_exceeded" => {
            error(StatusCode::CONFLICT, "quota_exceeded", "文件空间不足")
        }
        Ok(state) if state == "disk_full" => error(
            StatusCode::INSUFFICIENT_STORAGE,
            "disk_full",
            "磁盘空间不足",
        ),
        Ok(state) => json(
            StatusCode::OK,
            serde_json::json!({"state":state,"send_id":send,"attempt_id":attempt}),
        ),
        Err(_) => unavailable(),
    }
}

// 停止不依赖 HTTP abort：只有持久裁决禁止提交后才能报告停止，写入者退出前仍占额度。
pub(crate) async fn stop(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Path((send, attempt)): Path<(String, String)>,
) -> Response {
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    let (Some(send), Some(attempt)) = (id(&send), id(&attempt)) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_id", "无效标识");
    };
    if !service
        .transfers
        .ready
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return unavailable();
    }
    let result: Result<&str, sqlx::Error> = async {
        let mut tx = db.begin().await?;
        sqlx::query("UPDATE instance SET storage_id=storage_id WHERE singleton=1").execute(&mut *tx).await?;
        let state: Option<(String, String)> = sqlx::query_as("SELECT state,attempt_id FROM file_send WHERE send_id=?")
            .bind(&send).fetch_optional(&mut *tx).await?;
        if state.as_ref().is_some_and(|(state, _)| state == "success") { return Ok("success") }
        if state.is_none() && sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM message WHERE send_id=?")
            .bind(&send).fetch_one(&mut *tx).await? != 0 { return Ok("conflict") }
        if state.is_none() && sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM file_attempt_marker WHERE send_id=? AND attempt_id!=? AND is_first=1")
            .bind(&send).bind(&attempt).fetch_one(&mut *tx).await? != 0 { return Ok("conflict") }
        let owner: Option<String> = sqlx::query_scalar("SELECT send_id FROM file_attempt_marker WHERE attempt_id=?")
            .bind(&attempt).fetch_optional(&mut *tx).await?;
        let recorded: Option<String> = sqlx::query_scalar("SELECT send_id FROM file_attempt WHERE attempt_id=?")
            .bind(&attempt).fetch_optional(&mut *tx).await?;
        if owner.as_deref().is_some_and(|s| s != send) || recorded.as_deref().is_some_and(|s| s != send) { return Ok("conflict") }
        if owner.is_none() {
            // 后继的停止也可能先于准备到达；先记身份，不猜测它的前驱。
            // 后续准备会在同一事务绑定前驱并裁决唯一后继。
            // 标记只占控制记录而不预留额度；同一发送最多登记有限身份，防止恶意停止无限增长。
            let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attempt_marker WHERE send_id=? AND stopped=1")
                .bind(&send).fetch_one(&mut *tx).await?;
            let recent: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attempt_marker WHERE stopped=1 AND created_at >= unixepoch() - 3600")
                .fetch_one(&mut *tx).await?;
            // 未登记的停止身份会永久保留；除速率外还限制全库纯标记，
            // 但已登记发送的停止不能因别人填满标记额度而失去终止能力。
            let markers: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_attempt_marker WHERE stopped=1 AND send_id NOT IN (SELECT send_id FROM file_send)")
                .fetch_one(&mut *tx).await?;
            if recorded.is_none() && (count >= 64 || recent >= 64 || (state.is_none() && markers >= 4096)) { return Ok("busy") }
            sqlx::query("INSERT INTO file_attempt_marker (attempt_id,send_id) VALUES (?,?)")
                .bind(&attempt).bind(&send).execute(&mut *tx).await?;
        }
        if owner.is_some() {
            sqlx::query("UPDATE file_attempt_marker SET stopped=1 WHERE attempt_id=?")
                .bind(&attempt).execute(&mut *tx).await?;
        }
        if let Some((state, current)) = state {
            if current == attempt {
                if state == "prepared" || state == "writing" {
                    sqlx::query("UPDATE file_send SET state='cleaning' WHERE send_id=? AND state IN ('prepared','writing')")
                        .bind(&send).execute(&mut *tx).await?;
                    sqlx::query("UPDATE file_attempt SET state='cleaning' WHERE attempt_id=? AND state IN ('prepared','writing')")
                        .bind(&attempt).execute(&mut *tx).await?;
                } else if state == "failed" {
                    sqlx::query("UPDATE file_send SET state='stopped' WHERE send_id=? AND state='failed'")
                        .bind(&send).execute(&mut *tx).await?;
                    sqlx::query("UPDATE file_attempt SET state='stopped' WHERE attempt_id=? AND state='failed'")
                        .bind(&attempt).execute(&mut *tx).await?;
                }
            } else {
                sqlx::query("UPDATE file_attempt SET state='stopped' WHERE attempt_id=? AND send_id=? AND state='failed'")
                    .bind(&attempt).bind(&send).execute(&mut *tx).await?;
            }
        }
        tx.commit().await?;
        Ok("stopped")
    }.await;
    match result {
        Ok("success") => crate::messages::committed(&mut db, &send).await,
        Ok("stopped") => {
            // 清理只由后台协调，写入者仍可能持有文件句柄；响应仅承诺禁止提交。
            json(
                StatusCode::OK,
                serde_json::json!({"state":"stopped","send_id":send,"attempt_id":attempt}),
            )
        }
        Ok("busy") => error(
            StatusCode::TOO_MANY_REQUESTS,
            "transfer_busy",
            "停止请求过多",
        ),
        Ok("conflict") => error(StatusCode::CONFLICT, "attempt_conflict", "传输尝试不匹配"),
        _ => unavailable(),
    }
}

pub(crate) async fn content(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Path((send, attempt)): Path<(String, String)>,
    body: Body,
) -> Response {
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    if !service
        .transfers
        .ready
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return unavailable();
    }
    let permit = match service.transfers.slots.clone().try_acquire_owned() {
        Ok(v) => v,
        Err(_) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "transfer_busy",
                "传输名额已满",
            );
        }
    };
    let (Some(send), Some(attempt)) = (id(&send), id(&attempt)) else {
        return error(StatusCode::UNPROCESSABLE_ENTITY, "invalid_id", "无效标识");
    };
    // 写入资格与文件体由独立任务持有；请求 future 断开后也必须完成清理裁决。
    let transfers = service.transfers.clone();
    struct WriterGuard {
        transfers: Arc<Transfers>,
        send: String,
        preserve: bool,
    }
    impl Drop for WriterGuard {
        fn drop(&mut self) {
            // 无法确认 COMMIT 的任务留在内存保护表中，直到重启用持久结果裁决。
            if self.preserve {
                return;
            }
            let mut writers = self.transfers.writers.lock().unwrap();
            if let Some(count) = writers.get_mut(&self.send) {
                *count -= 1;
                if *count == 0 {
                    writers.remove(&self.send);
                }
            }
        }
    }
    // 注册在 spawn 前：协调线程不得在任务排队尚未执行时清理其预留。
    *transfers
        .writers
        .lock()
        .unwrap()
        .entry(send.clone())
        .or_default() += 1;
    let task = tokio::spawn(async move {
        let mut writer = WriterGuard {
            transfers,
            send: send.clone(),
            preserve: false,
        };
        let _permit = permit;
        let row: Option<(String, i64, String, String)> = match sqlx::query_as(
            "SELECT file_id,size,state,attempt_id FROM file_send WHERE send_id=?",
        )
        .bind(&send)
        .fetch_optional(&mut db)
        .await
        {
            Ok(v) => v,
            Err(_) => return unavailable(),
        };
        let Some((file_id, size, state, current)) = row else {
            return error(StatusCode::NOT_FOUND, "send_not_found", "发送不存在");
        };
        if state == "success" {
            if current != attempt {
                return error(StatusCode::CONFLICT, "attempt_conflict", "传输尝试不匹配");
            }
            return crate::messages::committed(&mut db, &send).await;
        }
        if current != attempt || state != "prepared" {
            return error(StatusCode::CONFLICT, "attempt_busy", "尝试不可写");
        }
        // 到期的准备不得在回收尚未运行时抢先取得写入资格；并发 PUT 由这条条件更新裁决。
        let cutoff =
            (service.config.now)() - service.config.transfer.prepare_timeout.as_secs() as i64;
        let result: Result<bool, sqlx::Error> = async {
        let mut tx = db.begin().await?;
        let changed = sqlx::query("UPDATE file_send SET state='writing' WHERE send_id=? AND attempt_id=? AND state='prepared' AND prepared_at > ?")
            .bind(&send).bind(&attempt).bind(cutoff).execute(&mut *tx).await?;
        if changed.rows_affected() != 1 { return Ok(false); }
        let attempt_changed = sqlx::query("UPDATE file_attempt SET state='writing' WHERE attempt_id=? AND send_id=? AND state='prepared'")
            .bind(&attempt).bind(&send).execute(&mut *tx).await?;
        if attempt_changed.rows_affected() != 1 { return Err(sqlx::Error::RowNotFound); }
        tx.commit().await?;
        Ok(true)
    }.await;
        match result {
            Ok(true) => (),
            Ok(false) => return error(StatusCode::CONFLICT, "attempt_busy", "尝试不可写"),
            Err(_) => {
                // 资格事务的 COMMIT 回调失败也无法证明其未持久化；保留预留，
                // 避免协调线程在请求即将写入或底层提交仍在进行时接管实体。
                writer.preserve = true;
                return unavailable();
            }
        }
        let (temp, final_path) = paths(&service, &file_id);
        let total = service.config.transfer.total_timeout;
        let idle = service.config.transfer.idle_timeout;
        let deadline = Instant::now() + total;
        // 请求中断时后台任务仍持有写入资格；旧写入者真正退出后才可清理并释放预留。
        // 总期限覆盖接收与落盘，但不能取消随后执行的目录同步和数据库提交。
        // SQLite 与文件系统不共事务；中途取消提交会造成无法裁决的成功状态。
        let mut commit_started = false;
        let outcome: Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
            // 私有实体采用排他创建和不跟随符号链接，异常路径不得覆盖已有文件。
            let mut file = OpenOptions::new().create_new(true).write(true)
                .mode(0o600).custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
                .open(&temp).await?;
            let mut received = 0i64;
            let mut stream = body.into_data_stream();
            let receive = async {
                while let Some(chunk) = tokio::time::timeout(idle, stream.try_next()).await?? {
                    received = received.checked_add(chunk.len() as i64).ok_or("size overflow")?;
                    if received > size { return Err("size mismatch".into()); }
                    file.write_all(&chunk).await?;
                }
                if received != size { return Err("size mismatch".into()); }
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            };
            let received_result = tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), receive).await;
            // Tokio 文件写入由阻塞线程执行，取消 future 后仍可能在写。
            // 等待 sync_all 收尾，再关闭句柄，旧写入者才真正退出。
            let sync_result = file.sync_all().await;
            drop(file);
            received_result??;
            sync_result?;
            if Instant::now() >= deadline { return Err("upload deadline exceeded".into()); }
            // 实体路径只由服务器生成，但也不能覆盖意外存在的正式文件。
            // 排他硬链接失败后清理本次临时实体，不替换其他消息的内容。
            fs::hard_link(&temp, &final_path).await?;
            fs::remove_file(&temp).await?;
            std::fs::File::open(&service.files)?.sync_all()?;
            let mut tx = db.begin().await?;
        let inserted = sqlx::query("INSERT INTO message (send_id,text,source_label,created_at,kind,file_id,file_name,file_size,file_mime) SELECT send_id,'',source_label,strftime('%Y-%m-%dT%H:%M:%SZ','now'),'FILE',file_id,name,size,mime FROM file_send WHERE send_id=? AND state='writing'")
            .bind(&send).execute(&mut *tx).await?;
        // 停止与提交在同一写事务中争夺状态：停止先落库则 SELECT 不会产生消息。
        if inserted.rows_affected()!=1 { return Err("commit lost".into()); }
        sqlx::query("UPDATE file_send SET state='success' WHERE send_id=?").bind(&send).execute(&mut *tx).await?;
        sqlx::query("UPDATE file_attempt SET state='success' WHERE attempt_id=?").bind(&attempt).execute(&mut *tx).await?;
        // COMMIT 已发出后即使回调报错，也不能推断 SQLite 没有持久化成功。
        // 保留实体与额度，交由下一次启动按持久结果裁决，不误删已提交文件。
        commit_started = true;
        tx.commit().await?;
        Ok(())
    }.await;
        if outcome.is_err() {
            if commit_started {
                // 用新连接裁决 COMMIT 的持久结果；只有确认仍是 writing 才能继续清理。
                // 无法独立读回时保留实体与预留，不能凭一次提交错误删除可能成功的消息。
                let result = match SqliteConnection::connect_with(&crate::storage::options(
                    &service.database.join("transfer.db"),
                ))
                .await
                {
                    Ok(mut check) => sqlx::query_scalar::<_, String>(
                        "SELECT state FROM file_send WHERE send_id=?",
                    )
                    .bind(&send)
                    .fetch_one(&mut check)
                    .await
                    .ok(),
                    Err(_) => None,
                };
                match result.as_deref() {
                    Some("success") => return crate::messages::committed(&mut db, &send).await,
                    // SQLite COMMIT 已被调用但回报失败；读到旧值不足以证明后台提交
                    // 不会稍后生效。运行期间保留保护标记，重启后再按持久结果裁决。
                    _ => {
                        writer.preserve = true;
                        return unavailable();
                    }
                }
            }
            // 即使在 COMMIT 前失败，也先检查持久状态；无法查询时保留实体与预留。
            match sqlx::query_scalar::<_, String>("SELECT state FROM file_send WHERE send_id=?")
                .bind(&send)
                .fetch_one(&mut db)
                .await
            {
                Ok(state) if state == "success" => {
                    return crate::messages::committed(&mut db, &send).await;
                }
                Err(_) => {
                    writer.preserve = true;
                    return unavailable(); // 无法裁决提交结果时绝不可删除实体。
                }
                _ => (),
            }
            // 清理失败时保留原预留；不能因写入失败就声称空间已经释放。
            let mut tx = match db.begin().await {
                Ok(tx) => tx,
                Err(_) => return unavailable(),
            };
            let changed = sqlx::query("UPDATE file_send SET state='cleaning' WHERE send_id=? AND attempt_id=? AND state IN ('writing','cleaning')")
                .bind(&send).bind(&attempt).execute(&mut *tx).await;
            if !matches!(changed, Ok(ref row) if row.rows_affected() == 1) {
                return unavailable();
            }
            if sqlx::query(
                "UPDATE file_attempt SET state='cleaning' WHERE attempt_id=? AND state='writing'",
            )
            .bind(&attempt)
            .execute(&mut *tx)
            .await
            .is_err()
            {
                return unavailable();
            }
            if tx.commit().await.is_err() {
                // 清理裁决的 COMMIT 结果未知时也禁止后台回收碰实体。
                writer.preserve = true;
                return unavailable();
            }
            // 只有持久状态已禁止提交时才能碰实体；清理失败继续占用额度。
            if !cleanup(&service, &mut db, &send, &file_id).await {
                return error(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "cleanup_pending",
                    "清理未完成，空间仍被占用",
                );
            }
            return error(
                StatusCode::UNPROCESSABLE_ENTITY,
                "upload_failed",
                "文件未提交或存储不可用",
            );
        }
        crate::messages::committed(&mut db, &send).await
    });
    match task.await {
        Ok(response) => response,
        Err(_) => error(
            StatusCode::SERVICE_UNAVAILABLE,
            "transfer_unknown",
            "传输结果未确认",
        ),
    }
}

#[derive(serde::Serialize, sqlx::FromRow)]
struct FileStatus {
    file_id: String,
    file_state: String,
    state_version: String,
}
async fn known_status(
    db: &mut SqliteConnection,
    file_id: &str,
) -> Result<Option<FileStatus>, sqlx::Error> {
    sqlx::query_as("SELECT file_id,file_state,CAST(state_version AS TEXT) AS state_version FROM message WHERE kind='FILE' AND file_id=?")
        .bind(file_id).fetch_optional(db).await
}
pub(crate) async fn status(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Path(raw): Path<String>,
) -> Response {
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    let Some(file_id) = id(&raw) else {
        return error(StatusCode::NOT_FOUND, "file_not_found", "文件不可用");
    };
    match known_status(&mut db, &file_id).await {
        Ok(Some(value)) => json(StatusCode::OK, value),
        Ok(None) => error(StatusCode::NOT_FOUND, "file_not_found", "文件不可用"),
        Err(_) => unavailable(),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StatusQuery {
    file_ids: Vec<String>,
}
pub(crate) async fn status_query(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    if headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(';').next())
        .is_none_or(|v| !v.trim().eq_ignore_ascii_case("application/json"))
    {
        return error(
            StatusCode::BAD_REQUEST,
            "json_required",
            "请求必须使用 JSON",
        );
    }
    let bytes = match tokio::time::timeout(Duration::from_secs(15), to_bytes(body, 8192)).await {
        Ok(Ok(v)) => v,
        _ => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "状态查询请求过大或超时",
            );
        }
    };
    let input: StatusQuery = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_query", "状态查询格式无效"),
    };
    if input.file_ids.is_empty()
        || input.file_ids.len() > 100
        || input.file_ids.iter().any(|raw| id(raw).is_none())
    {
        return error(
            StatusCode::BAD_REQUEST,
            "invalid_query",
            "每次须查询 1–100 个有效文件标识",
        );
    }
    // 只读取数据库已知状态；同一快照内去重，未知标识单独返回，不暗示实体曾被删除。
    let mut tx = match db.begin().await {
        Ok(v) => v,
        Err(_) => return unavailable(),
    };
    let mut seen = std::collections::HashSet::new();
    let mut files = Vec::new();
    let mut not_found = Vec::new();
    for raw in input.file_ids {
        let file_id = id(&raw).unwrap();
        if !seen.insert(file_id.clone()) {
            continue;
        }
        match known_status(&mut tx, &file_id).await {
            Ok(Some(value)) => files.push(value),
            Ok(None) => not_found.push(file_id),
            Err(_) => return unavailable(),
        }
    }
    if tx.commit().await.is_err() {
        return unavailable();
    }
    json(
        StatusCode::OK,
        serde_json::json!({"files":files,"not_found":not_found}),
    )
}

// 只有可确认的单文件缺失或类型/大小异常才改变记录；权限与 I/O 故障仍是全局不可用。
// 再核对受管位置，避免挂载消失产生的 ENOENT 被误记成文件丢失。记账和发送成功不变。
async fn persist_storage_error(
    service: &Service,
    db: &mut SqliteConnection,
    file_id: &str,
) -> Result<(), ()> {
    if !matches!(
        crate::storage::inspect(&service.database, &service.files).await,
        crate::storage::Status::Initialized
    ) {
        return Err(());
    }
    sqlx::query("UPDATE message SET file_state='storage_error',state_version=state_version+1 WHERE file_id=? AND kind='FILE' AND file_state='available'")
        .bind(file_id).execute(db).await.map_err(|_| ())?;
    Ok(())
}
async fn record_storage_error(
    service: &Service,
    db: &mut SqliteConnection,
    file_id: &str,
) -> Response {
    if persist_storage_error(service, db, file_id).await.is_err() {
        return unavailable();
    }
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "storage_error",
        "文件存储异常",
    )
}

pub(crate) async fn download(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Path(file_id): Path<String>,
) -> Response {
    let (mut db, _) = match authenticate(&service, &headers).await {
        Ok(v) => v,
        Err(e) => return *e,
    };
    let Some(file_id) = id(&file_id) else {
        return error(StatusCode::NOT_FOUND, "file_not_found", "文件不可用");
    };
    let row: Option<(String, i64, String)> = match sqlx::query_as(
        "SELECT file_name,file_size,file_state FROM message WHERE file_id=? AND kind='FILE'",
    )
    .bind(&file_id)
    .fetch_optional(&mut db)
    .await
    {
        Ok(v) => v,
        Err(_) => return unavailable(),
    };
    let Some((name, size, state)) = row else {
        return error(StatusCode::NOT_FOUND, "file_not_found", "文件不可用");
    };
    if state != "available" {
        return error(
            StatusCode::SERVICE_UNAVAILABLE,
            "storage_error",
            "文件存储异常或不可用",
        );
    }
    if size < 0 {
        return record_storage_error(&service, &mut db, &file_id).await;
    }
    let (_, path) = paths(&service, &file_id);
    // 不打开符号链接、目录或 FIFO；尤其不能在打开命名管道时无限等待写入者。
    match fs::symlink_metadata(&path).await {
        Ok(meta) if meta.file_type().is_file() => (),
        Ok(_) => return record_storage_error(&service, &mut db, &file_id).await,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return record_storage_error(&service, &mut db, &file_id).await;
        }
        Err(_) => return unavailable(),
    }
    let file = match OpenOptions::new()
        .read(true)
        .custom_flags((rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK).bits() as i32)
        .open(&path)
        .await
    {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return record_storage_error(&service, &mut db, &file_id).await;
        }
        Err(_) => return unavailable(),
    };
    match file.metadata().await {
        Ok(meta) if meta.is_file() && meta.len() == size as u64 => (),
        Ok(_) => return record_storage_error(&service, &mut db, &file_id).await,
        Err(_) => return unavailable(),
    }
    // 使用 RFC 5987 编码，不让原始名称进入头部；浏览器只能作为附件保存。
    let safe: String = name
        .chars()
        .filter(|c| {
            !c.is_control() && *c != '/' && *c != '\\' && *c != '\u{202e}' && *c != '\u{202d}'
        })
        .collect();
    let safe = if safe.is_empty() { "download" } else { &safe };
    let encoded = safe
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"!#$&+-.^_`|~".contains(b) {
                (*b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect::<String>();
    let permit = match service.transfers.downloads.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => {
            return error(
                StatusCode::TOO_MANY_REQUESTS,
                "transfer_busy",
                "下载名额已满",
            );
        }
    };
    let idle = service.config.transfer.download_idle_timeout;
    // 有界通道限制缓冲量；客户端不消费时，生产者的发送也受独立期限约束。
    let (sender, receiver) = tokio::sync::mpsc::channel::<Result<Vec<u8>, std::io::Error>>(2);
    tokio::spawn(async move {
        let _permit = permit;
        use tokio::io::AsyncReadExt;
        let mut file = file;
        let mut remaining = size as u64;
        while remaining > 0 {
            let mut buf = vec![0u8; remaining.min(65536) as usize];
            let read = tokio::time::timeout(idle, file.read(&mut buf)).await;
            match read {
                Ok(Ok(n)) if n > 0 => {
                    remaining -= n as u64;
                    buf.truncate(n);
                    if !matches!(
                        tokio::time::timeout(idle, sender.send(Ok(buf))).await,
                        Ok(Ok(()))
                    ) {
                        return;
                    }
                }
                other => {
                    let error = match other {
                        Ok(Ok(_)) => std::io::Error::new(
                            std::io::ErrorKind::UnexpectedEof,
                            "stored file shortened",
                        ),
                        Ok(Err(e)) => e,
                        Err(_) => {
                            std::io::Error::new(std::io::ErrorKind::TimedOut, "download stalled")
                        }
                    };
                    let _ = tokio::time::timeout(idle, sender.send(Err(error))).await;
                    return;
                }
            }
        }
    });
    let stream = futures_util::stream::try_unfold(receiver, |mut receiver| async move {
        receiver
            .recv()
            .await
            .transpose()
            .map(|chunk| chunk.map(|bytes| (bytes, receiver)))
    });
    let mut response = Body::from_stream(stream).into_response();
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        "application/octet-stream".parse().unwrap(),
    );
    response.headers_mut().insert(
        header::CONTENT_DISPOSITION,
        format!("attachment; filename*=UTF-8''{encoded}")
            .parse()
            .unwrap(),
    );
    response
        .headers_mut()
        .insert(header::CONTENT_LENGTH, size.to_string().parse().unwrap());
    response
        .headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    response
}
