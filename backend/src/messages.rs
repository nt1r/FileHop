use crate::session::{Service, authenticate, error, unavailable, write_origin_allowed};
use axum::{
    Json,
    body::{Body, to_bytes},
    extract::{Query, State},
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
    text: String,
    source_label: String,
    created_at: String,
}

// 固定采用 Spec 的 White_Space 集合，不依赖语言默认 trim；BOM 和零宽空格是合法正文。
fn whitespace(c: char) -> bool {
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
        let message = sqlx::query_as::<_, Message>("SELECT CAST(id AS TEXT) AS id, send_id, text, source_label, created_at FROM message WHERE send_id = ?")
            .bind(&input.send_id).fetch_one(&mut *tx).await?;
        // 必须等提交成功才可返回成功；5xx 不保证未保存，客户端仍须保留原发送身份。
        tx.commit().await?;
        Ok((inserted, message))
    }.await;
    match result {
        Ok((_, message))
            if message.text != input.text || message.source_label != input.source_label =>
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
        Err(_) => unavailable(),
    }
}

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
pub(crate) struct RecentQuery {
    limit: Option<u32>,
    before: Option<i64>,
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
    let (limit, boundary) = match query {
        Ok(Query(q))
            if (1..=100).contains(&q.limit.unwrap_or(50)) && q.before.is_none_or(|id| id > 0) =>
        {
            (q.limit.unwrap_or(50), q.before)
        }
        _ => {
            return error(
                StatusCode::BAD_REQUEST,
                "invalid_query",
                "limit 须为 1–100，before 须为有效正整数消息 ID；不支持其他查询参数",
            );
        }
    };
    let result: Result<serde_json::Value, sqlx::Error> = async {
        // 快照最大值和最近页同属一个读事务；期间的新提交留给独立的增量游标读取。
        let mut tx = connection.begin().await?;
        let cursor: i64 = sqlx::query_scalar("SELECT COALESCE(MAX(id), 0) FROM message").fetch_one(&mut *tx).await?;
        // 历史从排他边界向前取最近一页，多取一条判断是否还有旧记录；新增消息不会挤动旧页。
        let mut messages = if let Some(before) = boundary {
            sqlx::query_as::<_, Message>("SELECT CAST(id AS TEXT) AS id, send_id, text, source_label, created_at FROM message WHERE id < ? ORDER BY message.id DESC LIMIT ?")
                .bind(before).bind(limit + 1).fetch_all(&mut *tx).await?
        } else {
            sqlx::query_as::<_, Message>("SELECT CAST(id AS TEXT) AS id, send_id, text, source_label, created_at FROM message ORDER BY message.id DESC LIMIT ?")
                .bind(limit + 1).fetch_all(&mut *tx).await?
        };
        let has_older = messages.len() > limit as usize;
        messages.truncate(limit as usize);
        messages.reverse();
        let before = messages.first().map(|m| m.id.clone());
        tx.commit().await?;
        let mut page = serde_json::json!({"messages":messages,"before":before,"has_older":has_older});
        // 只有首次快照建立新增读取基线；旧页不提供可误用为新增进度的游标。
        if boundary.is_none() {
            page["sync_cursor"] = cursor.to_string().into();
        }
        Ok(page)
    }.await;
    match result {
        Ok(value) => json(StatusCode::OK, value),
        Err(_) => unavailable(),
    }
}
