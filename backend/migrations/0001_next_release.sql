CREATE TABLE instance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    storage_id TEXT NOT NULL
);
CREATE TABLE session (
    digest BLOB PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
-- 发送标识与消息同条提交；首次发布即支持 TEXT/FILE，不对尚未冻结的版本做伪升级。
CREATE TABLE message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    send_id TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    source_label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'TEXT' CHECK (kind IN ('TEXT', 'FILE')),
    file_id TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_mime TEXT
);
CREATE TABLE account (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL
);
-- 文件发送与文本消息共享 send_id 身份空间；提交前的尝试另行跟踪并预留额度。
CREATE TABLE file_send (
    send_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL,
    file_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    mime TEXT NOT NULL,
    source_label TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared', 'writing', 'cleaning', 'failed', 'success')),
    reserved INTEGER NOT NULL CHECK (reserved >= 0),
    prepared_at INTEGER NOT NULL
);
CREATE TABLE file_attempt (
    attempt_id TEXT PRIMARY KEY,
    send_id TEXT NOT NULL REFERENCES file_send(send_id),
    state TEXT NOT NULL CHECK (state IN ('prepared', 'writing', 'cleaning', 'failed', 'success'))
);
CREATE INDEX file_send_state ON file_send(state);
