CREATE TABLE instance (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    storage_id TEXT NOT NULL
);
CREATE TABLE session (
    digest BLOB PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
-- 正文与发送标识同属一条记录，提交或回滚一起发生，不留下只有标识的成功记录。
CREATE TABLE message (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    send_id TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    source_label TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE account (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    username TEXT NOT NULL,
    password_hash TEXT NOT NULL
);
