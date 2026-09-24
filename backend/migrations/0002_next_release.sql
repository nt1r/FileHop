-- 新迁移保留既有 TEXT 消息和发送标识；文件发送通过 message.send_id 与文本共享身份空间。
ALTER TABLE message ADD COLUMN kind TEXT NOT NULL DEFAULT 'TEXT' CHECK (kind IN ('TEXT', 'FILE'));
ALTER TABLE message ADD COLUMN file_id TEXT;
ALTER TABLE message ADD COLUMN file_name TEXT;
ALTER TABLE message ADD COLUMN file_size INTEGER;
ALTER TABLE message ADD COLUMN file_mime TEXT;
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
