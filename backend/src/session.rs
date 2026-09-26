use argon2::{Argon2, PasswordHash, PasswordVerifier};
use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use sha2::{Digest, Sha256};
use sqlx::{Connection, SqliteConnection};
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Semaphore;
use uuid::Uuid;

const LIFETIME: i64 = 12 * 60 * 60;
const WINDOW: i64 = 15 * 60;
const COOKIE: &str = "__Host-filehop";

// 时钟是进程内的测试边界，不通过环境变量或 HTTP 暴露改时间能力。
#[derive(Clone)]
pub struct Config {
    pub origin: String,
    pub trusted_proxy: Option<IpAddr>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub transfer: crate::files::TransferConfig,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            origin: "https://filehop.invalid".into(),
            trusted_proxy: None,
            transfer: crate::files::TransferConfig::default(),
            now: Arc::new(|| {
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs() as i64
            }),
        }
    }
}

#[derive(Default)]
struct Attempts {
    failures: VecDeque<i64>,
    pending: usize,
}
pub(crate) struct Service {
    pub(crate) database: PathBuf,
    pub(crate) files: PathBuf,
    pub(crate) config: Config,
    verification: Arc<Semaphore>,
    attempts: Mutex<HashMap<IpAddr, Attempts>>,
    pub(crate) transfers: Arc<crate::files::Transfers>,
}

pub fn router(database: PathBuf, files: PathBuf, config: Config) -> Router {
    router_inner(database, files, config, false)
}

// serve 已经在监听前完成恢复，不可再异步执行第二次协调，否则会误终止新上传。
pub(crate) fn recovered_router(database: PathBuf, files: PathBuf, config: Config) -> Router {
    router_inner(database, files, config, true)
}

fn router_inner(database: PathBuf, files: PathBuf, config: Config, recovered: bool) -> Router {
    let limit = config.transfer.active_limit;
    let files_ready = files.clone();
    let database_ready = database.clone();
    let transfers = Arc::new(crate::files::Transfers::new(limit));
    // 测试及嵌入式启动也必须完成协调后才开放上传；未初始化时仅诊断可用。
    if recovered {
        transfers
            .ready
            .store(true, std::sync::atomic::Ordering::Release);
    } else {
        let recovery = transfers.clone();
        tokio::spawn(async move {
            if crate::files::recover(&database_ready, &files_ready)
                .await
                .is_ok()
            {
                recovery
                    .ready
                    .store(true, std::sync::atomic::Ordering::Release);
            }
        });
    }
    let service = Arc::new(Service {
        database,
        files,
        config,
        verification: Arc::new(Semaphore::new(2)),
        attempts: Mutex::new(HashMap::new()),
        transfers,
    });
    let maintenance = Arc::downgrade(&service);
    tokio::spawn(async move {
        let mut delay = 5u64;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            // 路由销毁后不再持有存储句柄，旧协调者不能干扰新实例。
            let Some(maintenance) = maintenance.upgrade() else {
                break;
            };
            if !maintenance
                .transfers
                .ready
                .load(std::sync::atomic::Ordering::Acquire)
            {
                continue;
            }
            // 清理失败不释放预留；后台有限退避重试，而不是靠下一次用户请求触发。
            let result = async {
                let _guard = maintenance.transfers.gate.lock().await;
                let mut db = SqliteConnection::connect_with(&crate::storage::options(
                    &maintenance.database.join("transfer.db"),
                ))
                .await?;
                crate::files::reconcile(&maintenance, &mut db)
                    .await
                    .map_err(|_| sqlx::Error::RowNotFound)
            }
            .await;
            delay = if result.is_ok() {
                5
            } else {
                (delay * 2).min(60)
            };
        }
    });
    Router::new()
        .route("/api/session", get(current).post(login).delete(logout))
        .route("/api/sends/{send_id}", get(crate::messages::result))
        .route("/api/transfer-limits", get(crate::files::limits))
        .route("/api/file-sends/{send_id}", get(crate::files::send_status))
        .route(
            "/api/file-sends/{send_id}/attempts",
            axum::routing::post(crate::files::successor),
        )
        .route(
            "/api/file-sends",
            axum::routing::post(crate::files::prepare),
        )
        .route(
            "/api/file-sends/{send_id}/attempts/{attempt_id}/content",
            axum::routing::put(crate::files::content),
        )
        .route(
            "/api/file-sends/{send_id}/attempts/{attempt_id}/stop",
            axum::routing::post(crate::files::stop),
        )
        .route("/api/files/{file_id}", get(crate::files::download))
        .route(
            "/api/messages",
            get(crate::messages::recent).post(crate::messages::send),
        )
        .with_state(service)
}

pub(crate) fn error(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"code": code, "message": message})),
    )
        .into_response()
}
pub(crate) fn unavailable() -> Response {
    error(
        StatusCode::SERVICE_UNAVAILABLE,
        "unavailable",
        "应用暂不可用，请稍后重试",
    )
}
fn unauthorized() -> Response {
    error(StatusCode::UNAUTHORIZED, "session_invalid", "请重新登录")
}
fn invalid_credentials() -> Response {
    error(
        StatusCode::UNAUTHORIZED,
        "invalid_credentials",
        "用户名或密码错误",
    )
}
fn limited(seconds: i64) -> Response {
    let mut response = error(
        StatusCode::TOO_MANY_REQUESTS,
        "login_limited",
        "登录请求过多，请稍后重试",
    );
    response.headers_mut().insert(
        header::RETRY_AFTER,
        seconds.max(1).to_string().parse().unwrap(),
    );
    response
}

impl Service {
    pub(crate) fn for_recovery(database: PathBuf, files: PathBuf) -> Self {
        Self {
            database,
            files,
            config: Config::default(),
            verification: Arc::new(Semaphore::new(2)),
            attempts: Mutex::new(HashMap::new()),
            transfers: Arc::new(crate::files::Transfers::new(8)),
        }
    }
    async fn connection(&self) -> Result<SqliteConnection, Box<Response>> {
        if !matches!(
            crate::storage::inspect(&self.database, &self.files).await,
            crate::storage::Status::Initialized
        ) {
            return Err(Box::new(unavailable()));
        }
        SqliteConnection::connect_with(&crate::storage::options(&self.database.join("transfer.db")))
            .await
            .map_err(|_| Box::new(unavailable()))
    }
    fn source(
        &self,
        headers: &HeaderMap,
        peer: Option<ConnectInfo<SocketAddr>>,
    ) -> Result<IpAddr, Box<Response>> {
        let peer = peer
            .map(|p| p.0.ip())
            .unwrap_or(IpAddr::from([127, 0, 0, 1]));
        if self.config.trusted_proxy == Some(peer) {
            // 只接受精确受信代理覆盖的单个地址；不解析客户端可追加的 XFF 链。
            return headers
                .get("x-filehop-client-ip")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.parse().ok())
                .ok_or_else(|| {
                    Box::new(error(
                        StatusCode::BAD_REQUEST,
                        "invalid_source",
                        "请求来源无效",
                    ))
                });
        }
        Ok(peer)
    }
}

pub(crate) fn write_origin_allowed(service: &Service, headers: &HeaderMap) -> bool {
    headers.get_all(header::ORIGIN).iter().count() == 1
        && headers.get(header::ORIGIN).and_then(|v| v.to_str().ok())
            == Some(service.config.origin.as_str())
}

async fn logout(State(service): State<Arc<Service>>, headers: HeaderMap) -> Response {
    // 没有有效凭证也必须检查来源，否则跨站请求能强制清除浏览器的登录 Cookie。
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    if headers.contains_key(header::AUTHORIZATION) {
        return error(
            StatusCode::BAD_REQUEST,
            "unsupported_auth",
            "请求认证方式不被支持",
        );
    }
    let mut connection = match service.connection().await {
        Ok(c) => c,
        Err(e) => return *e,
    };
    // 不要求会话尚未到期：删除不存在的摘要也是成功。遇到重复 Cookie 时一并撤销，
    // 避免仅清除客户端 Cookie、却留下该请求携带的另一个有效会话。
    let result: Result<(), sqlx::Error> = async {
        let mut transaction = connection.begin().await?;
        for token in headers
            .get_all(header::COOKIE)
            .iter()
            .filter_map(|h| h.to_str().ok())
            .flat_map(|h| h.split(';'))
            .filter_map(|part| part.trim().strip_prefix("__Host-filehop="))
        {
            sqlx::query("DELETE FROM session WHERE digest = ?")
                .bind(Sha256::digest(token.as_bytes()).to_vec())
                .execute(&mut *transaction)
                .await?;
        }
        transaction.commit().await
    }
    .await;
    if result.is_err() {
        return unavailable();
    }
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (
                header::SET_COOKIE,
                "__Host-filehop=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
            ),
        ],
        Json(serde_json::json!({"state": "logged_out"})),
    )
        .into_response()
}

pub(crate) async fn authenticate(
    service: &Service,
    headers: &HeaderMap,
) -> Result<(SqliteConnection, i64), Box<Response>> {
    if headers.contains_key(header::AUTHORIZATION) {
        return Err(Box::new(unauthorized()));
    }
    let tokens: Vec<_> = headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|h| h.to_str().ok())
        .flat_map(|h| h.split(';'))
        .filter_map(|part| part.trim().strip_prefix(&format!("{COOKIE}=")))
        .collect();
    if tokens.len() != 1 || tokens[0].len() != 64 {
        return Err(Box::new(unauthorized()));
    }
    let mut connection = service.connection().await?;
    let now = (service.config.now)();
    match sqlx::query_scalar::<_, i64>(
        "SELECT expires_at FROM session WHERE digest = ? AND expires_at > ?",
    )
    .bind(Sha256::digest(tokens[0].as_bytes()).to_vec())
    .bind(now)
    .fetch_optional(&mut connection)
    .await
    {
        Ok(Some(expires)) => Ok((connection, expires)),
        Ok(None) => Err(Box::new(unauthorized())),
        Err(_) => Err(Box::new(unavailable())),
    }
}

async fn current(State(service): State<Arc<Service>>, headers: HeaderMap) -> Response {
    match authenticate(&service, &headers).await {
        Ok((_, expires)) => session_response(expires, (service.config.now)()),
        Err(response) => *response,
    }
}

fn session_response(expires: i64, now: i64) -> Response {
    (
        [(header::CACHE_CONTROL, "no-store")],
        Json(serde_json::json!({"expires_at": expires, "server_time": now})),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct Credentials {
    username: String,
    password: String,
}

async fn login(
    State(service): State<Arc<Service>>,
    peer: Option<axum::Extension<ConnectInfo<SocketAddr>>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    if headers.contains_key(header::AUTHORIZATION) {
        return error(
            StatusCode::BAD_REQUEST,
            "unsupported_auth",
            "请求认证方式不被支持",
        );
    }
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
    let body = match to_bytes(body, 8192).await {
        Ok(body) => body,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "登录请求过大",
            );
        }
    };
    let credentials: Credentials = match serde_json::from_slice(&body) {
        Ok(c) => c,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_json", "登录请求格式无效"),
    };
    let source = match service.source(&headers, peer.map(|p| p.0)) {
        Ok(s) => s,
        Err(e) => return *e,
    };
    let permit = match service.verification.clone().try_acquire_owned() {
        Ok(p) => p,
        Err(_) => return limited(1),
    };
    let now = (service.config.now)();
    {
        let mut attempts = service.attempts.lock().unwrap();
        attempts.retain(|_, a| {
            a.failures.retain(|t| *t > now - WINDOW);
            a.pending > 0 || !a.failures.is_empty()
        });
        // 计数表也有上限；新来源不能用无限地址耗尽内存，也不能驱逐旧来源绕过节流。
        if !attempts.contains_key(&source) && attempts.len() >= 4096 {
            return limited(WINDOW);
        }
        let attempt = attempts.entry(source).or_default();
        if attempt.failures.len() + attempt.pending >= 10 {
            return limited(attempt.failures.front().map_or(1, |t| t + WINDOW - now));
        }
        // 验证开始前原子预占一次机会，防止同时到达的请求越过第十次失败边界。
        attempt.pending += 1;
    }
    // 独立任务持有预算到验证真正结束；客户端断开不能提前释放并发槽或漏记失败。
    let task = tokio::spawn(async move {
        let response = verify_and_create(&service, credentials).await;
        let mut attempts = service.attempts.lock().unwrap();
        let attempt = attempts.get_mut(&source).unwrap();
        attempt.pending -= 1;
        if response.status() == StatusCode::UNAUTHORIZED {
            attempt.failures.push_back((service.config.now)());
        }
        drop(permit);
        response
    });
    task.await.unwrap_or_else(|_| unavailable())
}

async fn verify_and_create(service: &Service, credentials: Credentials) -> Response {
    let mut connection = match service.connection().await {
        Ok(c) => c,
        Err(e) => return *e,
    };
    let (username, hash): (String, String) =
        match sqlx::query_as("SELECT username, password_hash FROM account WHERE singleton = 1")
            .fetch_one(&mut connection)
            .await
        {
            Ok(v) => v,
            Err(_) => return unavailable(),
        };
    let valid_shape = (3..=32).contains(&credentials.username.len())
        && credentials
            .username
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        && (12..=128).contains(&credentials.password.chars().count());
    let matches_user = valid_shape && credentials.username.to_ascii_lowercase() == username;
    // 未知用户名也执行同一参数、同一开销的密码验证，但永远不能因此获得会话。
    let verified_hash = hash.clone();
    let verified = tokio::task::spawn_blocking(move || {
        PasswordHash::new(&hash).ok().is_some_and(|hash| {
            Argon2::default()
                .verify_password(credentials.password.as_bytes(), &hash)
                .is_ok()
        })
    })
    .await
    .unwrap_or(false);
    if !verified || !matches_user {
        return invalid_credentials();
    }
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let now = (service.config.now)();
    let expires = now + LIFETIME;
    let result: Result<(), sqlx::Error> = async {
        let mut transaction = connection.begin().await?;
        sqlx::query("DELETE FROM session WHERE expires_at <= ?")
            .bind(now)
            .execute(&mut *transaction)
            .await?;
        // 验证密码期间管理员可能已经重置。写事务内重新核对所验证的哈希，
        // 防止旧密码验证迟到后又创建逃过全部撤销的新会话。
        let inserted = sqlx::query("INSERT INTO session (digest, expires_at) SELECT ?, ? FROM account WHERE singleton = 1 AND password_hash = ?")
            .bind(Sha256::digest(token.as_bytes()).to_vec())
            .bind(expires)
            .bind(verified_hash)
            .execute(&mut *transaction)
            .await?;
        if inserted.rows_affected() != 1 { return Err(sqlx::Error::RowNotFound); }
        transaction.commit().await
    }
    .await;
    if result.is_err() {
        return unavailable();
    }
    let mut response = session_response(expires, now);
    response.headers_mut().insert(
        header::SET_COOKIE,
        format!("{COOKIE}={token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age={LIFETIME}")
            .parse()
            .unwrap(),
    );
    response
}
