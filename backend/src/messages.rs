use crate::session::{Service, authenticate, error, unavailable, write_origin_allowed};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::Connection;
use std::sync::Arc;

#[derive(Serialize, sqlx::FromRow)]
struct Message {
    id: String,
    send_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    source_label: String,
    created_at: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_mime: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_state: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    state_version: Option<String>,
}

// 固定采用 Spec 的 White_Space 集合，不依赖语言默认 trim；BOM 和零宽空格是合法正文。
pub(crate) fn whitespace(c: char) -> bool {
    matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{0085}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}')
}
fn json(status: StatusCode, value: impl Serialize) -> Response {
    (status, [(header::CACHE_CONTROL, "no-store")], Json(value)).into_response()
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Send {
    send_id: String,
    text: String,
    source_label: String,
}

pub(crate) async fn send(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    body: Body,
) -> Response {
    if !write_origin_allowed(&service, &headers) {
        return error(StatusCode::FORBIDDEN, "origin_rejected", "请求来源不被允许");
    }
    let (mut connection, _) = match authenticate(&service, &headers).await {
        Ok(c) => c,
        Err(e) => return *e,
    };
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
    let body = match to_bytes(body, 512 * 1024).await {
        Ok(b) => b,
        Err(_) => {
            return error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "body_too_large",
                "发送请求过大",
            );
        }
    };
    let mut input: Send = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(_) => return error(StatusCode::BAD_REQUEST, "invalid_json", "发送格式无效"),
    };
    input.source_label = input.source_label.trim_matches(whitespace).to_owned();
    let Ok(id) = uuid::Uuid::parse_str(&input.send_id) else {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_send_id",
            "发送标识无效",
        );
    };
    input.send_id = id.to_string();
    if input.text.len() > 65_536 {
        return error(
            StatusCode::PAYLOAD_TOO_LARGE,
            "text_too_large",
            "正文不能超过 65,536 UTF-8 字节",
        );
    }
    if input.text.chars().all(whitespace) {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "empty_text",
            "正文不能全为空白",
        );
    }
    if !(1..=64).contains(&input.source_label.chars().count()) {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_source_label",
            "来源标签须为 1–64 个字符",
        );
    }
    let result: Result<(bool, Message), sqlx::Error> = async {
        let mut tx = connection.begin().await?;
        // 首条语句即写入，用唯一约束裁决并发，避免先查后写造成两个发送都自认是新消息。
        let inserted = sqlx::query("INSERT INTO message (send_id, text, source_label, created_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now')) ON CONFLICT(send_id) DO NOTHING")
            .bind(&input.send_id).bind(&input.text).bind(&input.source_label).execute(&mut *tx).await?.rows_affected() == 1;
        // 插入已获得 SQLite 写锁，随后检查文件发送身份；冲突时回滚刚插入的文本。
        if sqlx::query_scalar::<_, i64>("SELECT COUNT(*) FROM file_send WHERE send_id=?").bind(&input.send_id).fetch_one(&mut *tx).await? != 0 { return Err(sqlx::Error::RowNotFound); }
        let message = sqlx::query_as::<_, Message>(message_query!("WHERE send_id = ?"))
            .bind(&input.send_id).fetch_one(&mut *tx).await?;
        // 必须等提交成功才可返回成功；5xx 不保证未保存，客户端仍须保留原发送身份。
        tx.commit().await?;
        Ok((inserted, message))
    }.await;
    match result {
        Ok((_, message))
            if message.kind != "TEXT"
                || message.text.as_deref() != Some(input.text.as_str())
                || message.source_label != input.source_label =>
        {
            error(
                StatusCode::CONFLICT,
                "send_conflict",
                "发送标识已用于其他载荷，请检查历史",
            )
        }
        Ok((inserted, message)) => json(
            if inserted {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            message,
        ),
        Err(sqlx::Error::RowNotFound) => {
            error(StatusCode::CONFLICT, "send_conflict", "发送标识已用于文件")
        }
        Err(_) => unavailable(),
    }
}

pub(crate) async fn result(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    Path(send_id): Path<String>,
) -> Response {
    // 标识不充当凭证；先认证，再查询已提交的记录。未找到只描述此刻，不取消在途写入。
    let (mut connection, _) = match authenticate(&service, &headers).await {
        Ok(c) => c,
        Err(e) => return *e,
    };
    let Ok(id) = uuid::Uuid::parse_str(&send_id) else {
        return error(
            StatusCode::UNPROCESSABLE_ENTITY,
            "invalid_send_id",
            "发送标识无效",
        );
    };
    committed(&mut connection, &id.to_string()).await
}

// 传输已在请求开始时认证。传输途中自然到期不应撤销刚提交的成功回执。
pub(crate) async fn committed(connection: &mut sqlx::SqliteConnection, send_id: &str) -> Response {
    match sqlx::query_as::<_, Message>(message_query!("WHERE send_id = ?"))
        .bind(send_id)
        .fetch_optional(connection)
        .await
    {
        Ok(Some(message)) => json(StatusCode::OK, message),
        Ok(None) => error(
            StatusCode::NOT_FOUND,
            "send_not_found",
            "暂未找到发送结果，不代表在途发送不会保存",
        ),
        Err(_) => unavailable(),
    }
}

// 所有消息读取共用投影，发送重放和历史不能各自编造文件状态。
macro_rules! message_query {
    ($tail:literal) => {
        concat!("SELECT CAST(id AS TEXT) AS id, send_id, CASE WHEN kind='TEXT' THEN text END AS text, source_label, created_at, kind, file_id, file_name, file_size, file_mime, CASE WHEN kind='FILE' THEN file_state END AS file_state, CASE WHEN kind='FILE' THEN CAST(state_version AS TEXT) END AS state_version FROM message ", $tail)
    };
}
use message_query;

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecentQuery {
    limit: Option<u32>,
    before: Option<i64>,
    after: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct FilesQuery {
    limit: Option<u32>,
    before: Option<i64>,
}

pub(crate) async fn files(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    query: Result<Query<FilesQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let (mut connection, _) = match authenticate(&service, &headers).await {
        Ok(c) => c,
        Err(e) => return *e,
    };
    let q = match query {
        Ok(Query(q))
            if (1..=100).contains(&q.limit.unwrap_or(50)) && q.before.is_none_or(|id| id > 0) =>
        {
            q
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_query",
                "limit 须为 1–100，before 须为正整数消息 ID",
            );
        }
    };
    let limit = q.limit.unwrap_or(50) as usize;
    // 消息只在文件提交成功后产生；排他 ID 游标不受新上传插入或将来删除影响。
    // 多取一条在同一查询快照中判断后续页，不检查磁盘、不把未提交上传当作文件。
    let result = sqlx::query_as::<_, Message>(message_query!("WHERE kind='FILE' AND file_state != 'deleted' AND (? IS NULL OR message.id < ?) ORDER BY message.id DESC LIMIT ?"))
        .bind(q.before).bind(q.before).bind((limit + 1) as i64).fetch_all(&mut connection).await;
    match result {
        Ok(mut files) => {
            let has_more = files.len() > limit;
            files.truncate(limit);
            let before = files.last().map(|m| m.id.clone());
            json(
                StatusCode::OK,
                serde_json::json!({"files": files, "before": before, "has_more": has_more}),
            )
        }
        Err(_) => unavailable(),
    }
}

pub(crate) async fn recent(
    State(service): State<Arc<Service>>,
    headers: HeaderMap,
    query: Result<Query<RecentQuery>, axum::extract::rejection::QueryRejection>,
) -> Response {
    let (mut connection, _) = match authenticate(&service, &headers).await {
        Ok(c) => c,
        Err(e) => return *e,
    };
    let (limit, boundary, after) = match query {
        Ok(Query(q))
            if (1..=100).contains(&q.limit.unwrap_or(50))
                && q.before.is_none_or(|id| id > 0)
                && q.after.is_none_or(|id| id >= 0)
                && !(q.before.is_some() && q.after.is_some()) =>
        {
            (q.limit.unwrap_or(50), q.before, q.after)
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_query",
                "limit 须为 1–100，before 须为正整数，after 须为非负整数消息 ID；两种边界互斥",
            );
        }
    };
    let result: Result<serde_json::Value, sqlx::Error> = async {
        // 快照最大值和最近页同属一个读事务；期间的新提交留给独立的增量游标读取。
        let mut tx = connection.begin().await?;
        // 增量从边界后最早记录开始，不能取最近页，否则离线期间超过一页的消息会永久遗漏。
        if let Some(after) = after {
            let mut messages = sqlx::query_as::<_, Message>(message_query!(
                "WHERE id > ? ORDER BY message.id ASC LIMIT ?"
            ))
            .bind(after)
            .bind(limit + 1)
            .fetch_all(&mut *tx)
            .await?;
            let has_more = messages.len() > limit as usize;
            messages.truncate(limit as usize);
            let after = messages.last().map(|m| m.id.clone());
            tx.commit().await?;
            return Ok(serde_json::json!({"messages":messages,"after":after,"has_more":has_more}));
        }
        let cursor: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) FROM message")
            .fetch_one(&mut *tx)
            .await?;
        // 历史从排他边界向前取最近一页，多取一条判断是否还有旧记录；新增消息不会挤动旧页。
        let mut messages = if let Some(before) = boundary {
            sqlx::query_as::<_, Message>(message_query!(
                "WHERE id < ? ORDER BY message.id DESC LIMIT ?"
            ))
            .bind(before)
            .bind(limit + 1)
            .fetch_all(&mut *tx)
            .await?
        } else {
            sqlx::query_as::<_, Message>(message_query!("ORDER BY message.id DESC LIMIT ?"))
                .bind(limit + 1)
                .fetch_all(&mut *tx)
                .await?
        };
        let has_older = messages.len() > limit as usize;
        messages.truncate(limit as usize);
        messages.reverse();
        let before = messages.first().map(|m| m.id.clone());
        tx.commit().await?;
        let mut page =
            serde_json::json!({"messages":messages,"before":before,"has_older":has_older});
        // 只有首次快照建立新增读取基线；旧页不提供可误用为新增进度的游标。
        if boundary.is_none() {
            page["sync_cursor"] = cursor.to_string().into();
        }
        Ok(page)
    }
    .await;
    match result {
        Ok(value) => json(StatusCode::OK, value),
        Err(_) => unavailable(),
    }
}
